import { HttpError, requireValue } from "./security.mjs";

/** Password sessions use owner-assigned account permissions or live Discord roles.
 * No user OAuth token or browser redirect is needed for this authentication mode.
 */
export function createPasswordVerifier({
  config,
  request = fetch,
  clock = Date.now,
  discord,
}) {
  const pending = new Map();
  return async function verify(user, tokens = {}, allowLocal = false) {
    requireValue(
      !tokens.discordId || tokens.discordId === user.discord_id,
      403,
      "Dit account is gewijzigd. Meld opnieuw aan.",
    );
    if (discord) {
      const checked = await discord.member({ demoId: user.discord_id });
      return {
        ...checked,
        tokens: { method: "password", discordId: user.discord_id },
      };
    }
    const saved = tokens.verification;
    if (
      saved?.guildId === config.guildId &&
      saved.identity?.id === user.discord_id &&
      Array.isArray(saved.roles) &&
      saved.expiresAt > clock() &&
      saved.expiresAt <= clock() + 30000
    )
      return { identity: saved.identity, roles: saved.roles, tokens };
    const local = () => {
      const identity = { id: user.discord_id, username: user.username };
      return {
        identity,
        roles: [],
        tokens: {
          method: "password",
          discordId: user.discord_id,
          verification: {
            identity,
            roles: [],
            guildId: config.guildId,
            expiresAt: clock() + 10000,
          },
        },
      };
    };
    if (!config.botToken || !config.guildId) {
      requireValue(
        allowLocal,
        503,
        "Stel een accountrol in bij Accounts, of configureer de Discord-bot voor dienstrollen.",
      );
      return local();
    }
    const key = config.guildId + ":" + user.discord_id;
    let check = pending.get(key);
    if (!check) {
      check = (async () => {
        let response;
        try {
          response = await request(
            `https://discord.com/api/v10/guilds/${config.guildId}/members/${user.discord_id}`,
            {
              headers: { Authorization: "Bot " + config.botToken },
              signal: AbortSignal.timeout(8000),
            },
          );
        } catch {
          throw new HttpError(
            503,
            "Je Discord-dienstrol kan nu niet worden gecontroleerd. Probeer het opnieuw.",
          );
        }
        if ([403, 404].includes(response.status))
          throw new HttpError(
            403,
            "Je hebt geen toegang via de overheids-Discord.",
          );
        requireValue(
          response.ok,
          503,
          "Je Discord-dienstrol kan nu niet worden gecontroleerd. Probeer het opnieuw.",
        );
        const membership = await response.json();
        requireValue(
          membership.user?.id === user.discord_id &&
            Array.isArray(membership.roles),
          503,
          "Discord gaf een ongeldige ledencontrole terug.",
        );
        return { identity: membership.user, roles: membership.roles };
      })();
      pending.set(key, check);
    }
    try {
      const verified = await check;
      return {
        ...verified,
        tokens: {
          method: "password",
          discordId: user.discord_id,
          verification: {
            ...verified,
            guildId: config.guildId,
            expiresAt: clock() + 30000,
          },
        },
      };
    } catch (error) {
      // Explicit local permissions belong to the account and do not depend on a
      // Discord outage. Never reuse old owner/command roles as a fallback.
      if (allowLocal) return local();
      throw error;
    } finally {
      if (pending.get(key) === check) pending.delete(key);
    }
  };
}
