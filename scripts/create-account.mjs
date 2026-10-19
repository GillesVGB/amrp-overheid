import readline from "node:readline/promises";
import { configFromEnv } from "../server/config.mjs";
import {
  openDatabase,
  id,
  timestamp,
  audit,
  transaction,
} from "../server/database.mjs";
import {
  snowflake,
  text,
  hashPassword,
  requireValue,
} from "../server/security.mjs";
// Initial provisioning runs on the server terminal, never through a public setup URL.
async function hiddenPrompt(prompt) {
  requireValue(
    process.stdin.isTTY,
    400,
    "Voer account:create uit in een interactieve terminal.",
  );
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const handler = (chunk) => {
      for (const c of chunk.toString()) {
        if (c === "\u0003") {
          finish();
          reject(Error("Afgebroken."));
          return;
        }
        if (c === "\r" || c === "\n") {
          finish();
          resolve(value);
          return;
        }
        if (c === "\u007f" || c === "\b") value = value.slice(0, -1);
        else value += c;
      }
    };
    const finish = () => {
      process.stdin.removeListener("data", handler);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
    };
    process.stdin.on("data", handler);
  });
}
let db;
try {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const username = text(
    (await rl.question("Gebruikersnaam [gilles]: ")) || "gilles",
    "Gebruikersnaam",
    80,
  ).toLowerCase();
  requireValue(
    /^[\p{L}\p{N}._-]+$/u.test(username),
    400,
    "Ongeldige gebruikersnaam.",
  );
  const discordId = snowflake(
    (await rl.question("Discord-ID [960090714950225970]: ")) ||
      "960090714950225970",
  );
  rl.close();
  const password = await hiddenPrompt(
      "Nieuw tijdelijk wachtwoord (min. 12 tekens, invoer verborgen): ",
    ),
    repeat = await hiddenPrompt("Herhaal wachtwoord: ");
  requireValue(password === repeat, 400, "Wachtwoorden komen niet overeen.");
  const hash = await hashPassword(password);
  db = openDatabase(configFromEnv());
  const existing = db
    .prepare("SELECT * FROM users WHERE discord_id=? OR username=?")
    .all(discordId, username);
  requireValue(
    existing.length <= 1,
    409,
    "Gebruikersnaam en Discord-ID horen bij verschillende accounts.",
  );
  const row = existing[0];
  requireValue(
    !row || (row.discord_id === discordId && row.username === username),
    409,
    "Deze gebruikersnaam of Discord-ID is al gekoppeld aan een ander account.",
  );
  const actor = { id: "server-terminal", username: "Serverbeheer" };
  transaction(db, () => {
    if (row) {
      db.prepare(
        "UPDATE users SET password_hash=?,enabled=1,must_change=1 WHERE id=?",
      ).run(hash, row.id);
      db.prepare("DELETE FROM sessions WHERE user_id=?").run(row.id);
      audit(db, actor, "account.hersteld_via_terminal", row.id);
    } else {
      const target = id();
      db.prepare("INSERT INTO users VALUES(?,?,?,?,1,1,?)").run(
        target,
        username,
        discordId,
        hash,
        timestamp(),
      );
      audit(db, actor, "account.aangemaakt_via_terminal", target, null, {
        username,
        discordId,
      });
    }
  });
  console.log(
    "Account opgeslagen. Discord-identiteit en serverrol worden bij aanmelden gecontroleerd.",
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  db?.close();
}
