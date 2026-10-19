import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { configFromEnv } from "../server/config.mjs";
import { createApp } from "../server/app.mjs";
import {
  openDatabase,
  id,
  timestamp,
  savePersonnel,
  getSettings,
} from "../server/database.mjs";
import { hashPassword } from "../server/security.mjs";
if (process.env.NODE_ENV === "production")
  throw Error("De demonstratieserver mag niet in productie worden gestart.");
const config = configFromEnv({
  NODE_ENV: "development",
  PORT: "4401",
  APP_ORIGIN: "http://127.0.0.1:4401",
  DATA_DIR: "data/demo-v2",
  TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
});
config.demo = true;
config.host = "127.0.0.1";
const db = openDatabase(config),
  settings = getSettings(db),
  identities = {};
const accounts = [
  ["beheer", "990000000000000001", "admin"],
  ["leiding", "990000000000000002", "command"],
  ["agent", "990000000000000003", "police"],
];
for (const [username, discordId, role] of accounts) {
  identities[discordId] = { username, roles: settings.roles[role] };
  const hash = await hashPassword("Werkplek-Demo2026!");
  db.prepare(
    "INSERT INTO users VALUES(?,?,?,?,1,0,?) ON CONFLICT(discord_id) DO UPDATE SET password_hash=excluded.password_hash,must_change=0,enabled=1",
  ).run(id(), username, discordId, hash, timestamp());
}
if (!db.prepare("SELECT id FROM personnel LIMIT 1").get()) {
  const actor = { id: "demo-seed", username: "Demonstratie" },
    ranks = db.prepare("SELECT * FROM ranks ORDER BY position").all();
  const names = [
    "D. de Vries",
    "N. Bakker",
    "M. van Dijk",
    "S. Jansen",
    "R. Meijer",
    "L. Visser",
    "A. Smit",
    "T. de Groot",
  ];
  names.forEach((name, index) => {
    const rank = ranks[[0, 3, 5, 6, 7, 8, 8, 9][index]],
      slot = db
        .prepare(
          "SELECT id FROM callsigns WHERE rank_id=? AND personnel_id IS NULL LIMIT 1",
        )
        .get(rank.id);
    savePersonnel(db, actor, {
      discordId: String(980000000000000000n + BigInt(index)),
      discordName: name,
      rankId: rank.id,
      callsignId: slot.id,
      place: ["Centrum", "Noord", "Zuid", "West"][index % 4],
      active: index !== 6,
    });
  });
  const category = db
    .prepare("SELECT id FROM categories WHERE name=?")
    .get("Interne mededelingen");
  db.prepare("INSERT INTO archive VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(
    id(),
    "Overdracht avonddienst",
    category.id,
    "Voorbeeldnotitie voor de lokale demonstratie.",
    "Dit is fictieve demonstratie-inhoud. Er worden geen echte personeelsgegevens gebruikt.",
    null,
    null,
    0,
    null,
    "demo-seed",
    timestamp(),
    timestamp(),
  );
}
const service = await createApp(config, {
  db,
  discord: {
    async member(tokens) {
      const entry = identities[tokens.demoId];
      if (!entry) throw Error("Onbekende demonstratie-identiteit.");
      return {
        identity: { id: tokens.demoId, username: entry.username },
        roles: entry.roles,
        tokens,
      };
    },
  },
});
const server = service.app.listen(4401, "127.0.0.1", () =>
  console.log(
    "Lokale demonstratie: http://127.0.0.1:4401\nAccounts: beheer, leiding, agent • wachtwoord: Werkplek-Demo2026!\nAlleen loopback. Geen verbinding met echte Discord.",
  ),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () =>
    server.close(() => {
      service.close();
      process.exit(0);
    }),
  );
