import {
  getSettings,
  getAccountAccess,
  id,
  timestamp,
  audit,
  transaction,
} from "./database.mjs";
import {
  permissions,
  applyAccountAccess,
  requireValue,
  snowflake,
  hashPassword,
  token,
} from "./security.mjs";

/** Discord establishes identity; existing account grants or service roles establish access. */
export async function completeDiscordLogin(db, verified, ownerRoles = []) {
  const discordId = snowflake(verified.identity.id);
  const settings = getSettings(db);
  const base = permissions(verified.roles, settings, ownerRoles);
  let user = db
    .prepare("SELECT * FROM users WHERE discord_id=?")
    .get(discordId);
  requireValue(
    !user || user.enabled,
    403,
    "Dit account is uitgeschakeld. Neem contact op met de eigenaar.",
  );
  const grants = applyAccountAccess(
    base,
    user ? getAccountAccess(db, user.id) : null,
    settings,
  );
  requireValue(
    Object.values(grants).some(Boolean),
    403,
    "Je hebt geen toegang. De eigenaar kan je Discord-ID toevoegen bij Accounts, of je hebt een toegestane dienstrol nodig.",
  );
  // A random unusable password keeps the existing schema compatible. No password
  // is issued, returned or required by the Discord login flow.
  const passwordHash = user ? null : await hashPassword(token());
  return transaction(db, () => {
    // Re-read after hashing so concurrent first sign-ins cannot create duplicates
    // or re-enable a record disabled by the owner while Discord was being checked.
    user = db.prepare("SELECT * FROM users WHERE discord_id=?").get(discordId);
    requireValue(!user || user.enabled, 403, "Dit account is uitgeschakeld.");
    if (!user) {
      let username = "discord_" + discordId,
        suffix = 1;
      while (db.prepare("SELECT id FROM users WHERE username=?").get(username))
        username = "discord_" + discordId + "_" + suffix++;
      user = {
        id: id(),
        username,
        discord_id: discordId,
        password_hash: passwordHash,
        enabled: 1,
        must_change: 0,
        created_at: timestamp(),
      };
      db.prepare(
        "INSERT INTO users(id,username,discord_id,password_hash,enabled,must_change,created_at) VALUES(?,?,?,?,1,0,?)",
      ).run(
        user.id,
        user.username,
        user.discord_id,
        user.password_hash,
        user.created_at,
      );
      audit(db, user, "account.discord_aangemaakt", user.id, null, {
        discordId,
      });
    } else if (user.must_change) {
      db.prepare("UPDATE users SET must_change=0 WHERE id=?").run(user.id);
      user = { ...user, must_change: 0 };
    }
    const latest = applyAccountAccess(
      permissions(verified.roles, getSettings(db), ownerRoles),
      getAccountAccess(db, user.id),
      getSettings(db),
    );
    requireValue(
      Object.values(latest).some(Boolean),
      403,
      "Je hebt geen toegang tot deze omgeving.",
    );
    return user;
  });
}
