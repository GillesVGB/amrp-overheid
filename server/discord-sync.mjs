import { HttpError, requireValue, text } from "./security.mjs";
import { id, timestamp, transaction, audit, getSettings } from "./database.mjs";

export function createDiscordSync({ db, config, request = fetch }) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS sync_state(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL)",
  );
  let current = null;
  const actor = { id: "discord-sync", username: "Discord-synchronisatie" };
  function status() {
    const saved = db.prepare("SELECT value FROM sync_state WHERE id=1").get();
    return {
      configured: Boolean(config.botToken),
      ...(saved ? JSON.parse(saved.value) : { lastSync: null, error: null }),
    };
  }
  function store(value) {
    db.prepare("INSERT OR REPLACE INTO sync_state VALUES(1,?)").run(
      JSON.stringify(value),
    );
  }
  async function discord(endpoint) {
    requireValue(
      config.botToken,
      503,
      "Stel DISCORD_BOT_TOKEN in op de server.",
    );
    const response = await request(
      "https://discord.com/api/v10/guilds/" + config.guildId + endpoint,
      {
        headers: { Authorization: "Bot " + config.botToken },
        signal: AbortSignal.timeout(15000),
      },
    );
    if (response.status === 401)
      throw new HttpError(503, "Het Discord-bottoken is ongeldig.");
    if (response.status === 403)
      throw new HttpError(
        503,
        "De bot kan geen leden ophalen. Controleer servertoegang en Server Members Intent.",
      );
    if (response.status === 404)
      throw new HttpError(
        503,
        "De bot heeft geen toegang tot deze Discord-server.",
      );
    if (response.status === 429)
      throw new HttpError(
        503,
        "Discord vraagt om te wachten. Probeer de synchronisatie later opnieuw.",
      );
    requireValue(response.ok, 503, "Discord is tijdelijk niet bereikbaar.");
    return response.json();
  }
  const roles = async () =>
    (await discord("/roles"))
      .filter((x) => !x.managed && x.id !== config.guildId)
      .map((x) => ({ id: x.id, name: x.name, position: x.position }))
      .sort((a, b) => b.position - a.position);
  async function run(requestActor = actor) {
    if (current) return current;
    current = (async () => {
      try {
        const actualRoles = await roles(),
          all = [];
        let after = "0";
        for (let page = 0; page < 100; page++) {
          const members = await discord("/members?limit=1000&after=" + after);
          all.push(...members);
          if (members.length < 1000) break;
          after = members.reduce(
            (max, x) => (BigInt(x.user.id) > BigInt(max) ? x.user.id : max),
            after,
          );
          requireValue(
            page < 99,
            503,
            "Te veel serverleden voor één synchronisatie.",
          );
        }
        const ranks = db
          .prepare("SELECT * FROM ranks WHERE discord_role_id IS NOT NULL")
          .all();
        const rankRoles = ranks
          .map((rank) => ({
            rank,
            role: actualRoles.find((x) => x.id === rank.discord_role_id),
          }))
          .filter((x) => x.role)
          .sort((a, b) => b.role.position - a.role.position);
        requireValue(
          rankRoles.length,
          400,
          "Koppel eerst de rangrollen uit Discord aan de rangen.",
        );
        const missingRoles = ranks
            .filter((x) => !actualRoles.some((r) => r.id === x.discord_role_id))
            .map((x) => x.label),
          settings = getSettings(db);
        const relevant = all.filter(
          (x) =>
            !x.user.bot &&
            (x.roles.some(
              (r) =>
                settings.roles.police.includes(r) ||
                settings.roles.command.includes(r),
            ) ||
              rankRoles.some((pair) => x.roles.includes(pair.role.id))),
        );
        const result = {
          lastSync: timestamp(),
          error: null,
          added: 0,
          updated: 0,
          deactivated: 0,
          unranked: 0,
          unrankedMembers: [],
          callsignConflicts: 0,
          missingRoles,
          source: "discord",
        };
        transaction(db, () => {
          for (const [position, pair] of rankRoles.entries()) {
            const label = text(
              pair.role.name.replace(/^.*?\|\s*/, ""),
              "Rangnaam",
              80,
            );
            if (label !== pair.rank.label) {
              audit(
                db,
                requestActor,
                "discord.rang_bijgewerkt",
                pair.rank.id,
                { label: pair.rank.label },
                { label },
              );
            }
            db.prepare("UPDATE ranks SET label=?,position=? WHERE id=?").run(
              label,
              position,
              pair.rank.id,
            );
          }
          const seen = new Set();
          for (const member of relevant) {
            const pair = rankRoles.find((x) =>
              member.roles.includes(x.role.id),
            );
            if (!pair) {
              result.unranked++;
              result.unrankedMembers.push({
                discordId: member.user.id,
                name: text(
                  member.nick ||
                    member.user.global_name ||
                    member.user.username,
                  "Discord-naam",
                  80,
                ),
                roles: actualRoles
                  .filter((role) => member.roles.includes(role.id))
                  .map((role) => role.name),
              });
              continue;
            }
            seen.add(member.user.id);
            const name = text(
                member.nick || member.user.global_name || member.user.username,
                "Discord-naam",
                80,
              ),
              rank = pair.rank;
            const before = db
              .prepare("SELECT * FROM personnel WHERE discord_id=?")
              .get(member.user.id);
            const target = before?.id || id();
            if (before) {
              if (before.rank_id !== rank.id)
                db.prepare(
                  "UPDATE callsigns SET personnel_id=NULL,place='' WHERE personnel_id=?",
                ).run(target);
              if (
                before.discord_name !== name ||
                before.rank_id !== rank.id ||
                !before.active ||
                before.source !== "discord"
              ) {
                db.prepare(
                  "UPDATE personnel SET discord_name=?,rank_id=?,active=1,source='discord',updated_at=? WHERE id=?",
                ).run(name, rank.id, timestamp(), target);
                result.updated++;
                audit(
                  db,
                  requestActor,
                  "discord.personeel_bijgewerkt",
                  target,
                  {
                    name: before.discord_name,
                    rankId: before.rank_id,
                    active: before.active,
                  },
                  { name, rankId: rank.id, active: 1 },
                );
              }
            } else {
              db.prepare(
                "INSERT INTO personnel(id,discord_id,discord_name,rank_id,active,created_at,updated_at,source) VALUES(?,?,?,?,1,?,?,'discord')",
              ).run(
                target,
                member.user.id,
                name,
                rank.id,
                timestamp(),
                timestamp(),
              );
              result.added++;
              audit(
                db,
                requestActor,
                "discord.personeel_toegevoegd",
                target,
                null,
                { discordId: member.user.id, name, rankId: rank.id },
              );
            }
            db.prepare(
              "UPDATE personnel SET callsign_issue=NULL WHERE id=?",
            ).run(target);
            // Only explicit, recognizable callsigns are imported; no fictional places or assignments.
            const match = name.match(/(?:^|[^\d])(\d{2})[-.](\d{2,3})(?!\d)/);
            if (
              match &&
              !db
                .prepare("SELECT id FROM callsigns WHERE personnel_id=?")
                .get(target)
            ) {
              const number = match[1] + "-" + match[2].padStart(3, "0"),
                slot = db
                  .prepare(
                    "SELECT * FROM callsigns WHERE rank_id=? AND number=?",
                  )
                  .get(rank.id, number);
              if (slot && !slot.personnel_id) {
                db.prepare(
                  "UPDATE callsigns SET personnel_id=? WHERE id=?",
                ).run(target, slot.id);
                audit(
                  db,
                  requestActor,
                  "discord.roepnummer_toegewezen",
                  target,
                  null,
                  { number },
                );
              } else {
                const issue = slot
                  ? `Roepnummer ${number} is al toegewezen; laat de korpsleiding dit controleren.`
                  : `Nummer ${number} past niet bij de reeks ${rank.code} (${rank.label}); laat de korpsleiding dit controleren.`;
                db.prepare(
                  "UPDATE personnel SET callsign_issue=? WHERE id=?",
                ).run(issue, target);
                result.callsignConflicts++;
              }
            }
          }
          for (const person of db
            .prepare(
              "SELECT * FROM personnel WHERE source='discord' AND active=1",
            )
            .all())
            if (!seen.has(person.discord_id)) {
              db.prepare(
                "UPDATE personnel SET active=0,callsign_issue=NULL,updated_at=? WHERE id=?",
              ).run(timestamp(), person.id);
              db.prepare(
                "UPDATE callsigns SET personnel_id=NULL,place='' WHERE personnel_id=?",
              ).run(person.id);
              result.deactivated++;
              audit(
                db,
                requestActor,
                "discord.personeel_inactief",
                person.id,
                { active: 1 },
                { active: 0 },
              );
            }
          audit(
            db,
            requestActor,
            "discord.gesynchroniseerd",
            "politie",
            null,
            result,
          );
          store(result);
        });
        return result;
      } catch (error) {
        store({
          ...status(),
          error: error.status
            ? error.message
            : "Discord-synchronisatie is tijdelijk niet beschikbaar.",
        });
        throw error;
      } finally {
        current = null;
      }
    })();
    return current;
  }
  return { status, roles, run };
}
