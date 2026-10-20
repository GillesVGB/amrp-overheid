import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import {
  HttpError,
  requireValue,
  text,
  positive,
  snowflake,
} from "./security.mjs";
import discordRanks from "./discord-ranks.json" with { type: "json" };
import { installWorkspaceSchema } from "./workspace-schema.mjs";
export const id = () => randomUUID();
export const timestamp = () => new Date().toISOString();
export function openDatabase(config) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(config.dataDir, "portal.sqlite"));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT NOT NULL COLLATE NOCASE UNIQUE,discord_id TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,must_change INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS account_access(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,profile TEXT NOT NULL,permissions TEXT NOT NULL,updated_at TEXT NOT NULL,updated_by TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,csrf TEXT NOT NULL,tokens TEXT NOT NULL,expires_at INTEGER NOT NULL,last_seen INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS auth_flows(hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,kind TEXT NOT NULL,expires_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS signup_flows(hash TEXT PRIMARY KEY,username TEXT NOT NULL,expires_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS discord_login_flows(hash TEXT PRIMARY KEY,verifier TEXT NOT NULL,expires_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS user_preferences(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,wallpaper TEXT NOT NULL DEFAULT 'bloom',theme TEXT NOT NULL DEFAULT 'light',updated_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS deleted_callsigns(id TEXT PRIMARY KEY,snapshot TEXT NOT NULL,deleted_by TEXT NOT NULL,deleted_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS rate_limits(key TEXT PRIMARY KEY,count INTEGER NOT NULL,expires_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS ranks(id TEXT PRIMARY KEY,code TEXT NOT NULL UNIQUE,label TEXT NOT NULL,capacity INTEGER NOT NULL,special INTEGER NOT NULL,position INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS personnel(id TEXT PRIMARY KEY,discord_id TEXT NOT NULL UNIQUE,discord_name TEXT NOT NULL,rank_id TEXT NOT NULL REFERENCES ranks(id),active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS callsigns(id TEXT PRIMARY KEY,rank_id TEXT NOT NULL REFERENCES ranks(id) ON DELETE CASCADE,number TEXT NOT NULL,slot INTEGER NOT NULL,personnel_id TEXT UNIQUE REFERENCES personnel(id) ON DELETE SET NULL,place TEXT NOT NULL DEFAULT '',UNIQUE(rank_id,number),UNIQUE(rank_id,slot));
 CREATE TABLE IF NOT EXISTS categories(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE);
 CREATE TABLE IF NOT EXISTS archive(id TEXT PRIMARY KEY,title TEXT NOT NULL,category_id TEXT NOT NULL REFERENCES categories(id),description TEXT NOT NULL DEFAULT '',note TEXT NOT NULL DEFAULT '',filename TEXT,mime TEXT,size INTEGER NOT NULL DEFAULT 0,storage_name TEXT,created_by TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS ambulance_calls(id TEXT PRIMARY KEY,call_number TEXT NOT NULL UNIQUE,priority TEXT NOT NULL CHECK(priority IN ('Regulier','Spoed')),status TEXT NOT NULL CHECK(status IN ('Nieuw','Eenheid toegewezen','Onderweg','Ter plaatse','Afgerond')),location TEXT NOT NULL,summary TEXT NOT NULL,unit TEXT NOT NULL DEFAULT '',created_by TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS sync_state(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT,actor_id TEXT NOT NULL,actor_name TEXT NOT NULL,action TEXT NOT NULL,target TEXT NOT NULL,before_json TEXT,after_json TEXT,created_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS audit_date ON audit(created_at);
 CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
 `);
  if (
    !db
      .prepare("PRAGMA table_info(user_preferences)")
      .all()
      .some((x) => x.name === "theme")
  )
    db.exec(
      "ALTER TABLE user_preferences ADD COLUMN theme TEXT NOT NULL DEFAULT 'light'",
    );
  if (
    !db
      .prepare("PRAGMA table_info(ranks)")
      .all()
      .some((x) => x.name === "discord_role_id")
  )
    db.exec("ALTER TABLE ranks ADD COLUMN discord_role_id TEXT");
  if (
    !db
      .prepare("PRAGMA table_info(personnel)")
      .all()
      .some((x) => x.name === "source")
  )
    db.exec(
      "ALTER TABLE personnel ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'",
    );
  if (
    !db
      .prepare("PRAGMA table_info(personnel)")
      .all()
      .some((x) => x.name === "callsign_issue")
  )
    db.exec("ALTER TABLE personnel ADD COLUMN callsign_issue TEXT");
  if (
    !db
      .prepare("PRAGMA table_info(personnel)")
      .all()
      .some((x) => x.name === "discord_roles")
  )
    db.exec(
      "ALTER TABLE personnel ADD COLUMN discord_roles TEXT NOT NULL DEFAULT '[]'",
    );
  if (
    !db
      .prepare("PRAGMA table_info(personnel)")
      .all()
      .some((x) => x.name === "place")
  ) {
    db.exec("ALTER TABLE personnel ADD COLUMN place TEXT NOT NULL DEFAULT ''");
    db.exec(`UPDATE personnel SET place=COALESCE(
      (SELECT callsigns.place FROM callsigns WHERE callsigns.personnel_id=personnel.id),
      ''
    )`);
  }
  installWorkspaceSchema(db);
  if (!db.prepare("SELECT id FROM settings").get()) {
    db.prepare("INSERT INTO settings VALUES(1,?)").run(
      JSON.stringify({
        name: "Amsterdam • Overheid",
        roles: config.roles,
        grants: { policeRead: [], policeWrite: [], archive: [], audit: [] },
        ambulanceEnabled: false,
      }),
    );
    transaction(db, () =>
      discordRanks.forEach((entry, index) => {
        const rank = {
          id: id(),
          code: entry.code,
          label: entry.label,
          capacity: index < 5 ? 1 : 30,
          special: index < 5 ? 1 : 0,
          position: index,
        };
        db.prepare(
          "INSERT INTO ranks(id,code,label,capacity,special,position,discord_role_id) VALUES(?,?,?,?,?,?,?)",
        ).run(
          rank.id,
          rank.code,
          rank.label,
          rank.capacity,
          rank.special,
          rank.position,
          entry.roleId,
        );
        for (let i = 1; i <= rank.capacity; i++) insertSlot(db, rank, i);
      }),
    );
    for (const name of [
      "Algemene notities",
      "Personeelsdocumenten",
      "Opleidingen",
      "Interne mededelingen",
      "Rapportages",
      "Overige documenten",
    ])
      db.prepare("INSERT INTO categories VALUES(?,?)").run(id(), name);
  }
  db.prepare("DELETE FROM deleted_callsigns WHERE deleted_at<?").run(
    new Date(Date.now() - 30 * 60 * 1000).toISOString(),
  );
  return db;
}
export function transaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
export const getSettings = (db) =>
  JSON.parse(db.prepare("SELECT value FROM settings WHERE id=1").get().value);
export const publicUser = (user) => ({
  id: user.id,
  username: user.username,
  discordId: user.discord_id,
  enabled: Boolean(user.enabled),
  mustChange: Boolean(user.must_change),
  createdAt: user.created_at,
});
export function getAccountAccess(db, userId) {
  const row = db
    .prepare("SELECT profile,permissions FROM account_access WHERE user_id=?")
    .get(userId);
  if (!row) return null;
  try {
    return { profile: row.profile, permissions: JSON.parse(row.permissions) };
  } catch {
    return null;
  }
}
export function setAccountAccess(db, userId, access, actorId) {
  if (!access || access.profile === "discord") {
    db.prepare("DELETE FROM account_access WHERE user_id=?").run(userId);
    return;
  }
  db.prepare(
    `INSERT INTO account_access(user_id,profile,permissions,updated_at,updated_by)
     VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET
     profile=excluded.profile,permissions=excluded.permissions,
     updated_at=excluded.updated_at,updated_by=excluded.updated_by`,
  ).run(
    userId,
    access.profile,
    JSON.stringify(access.permissions),
    timestamp(),
    actorId,
  );
}
export function audit(db, actor, action, target, before = null, after = null) {
  db.prepare(
    "INSERT INTO audit(actor_id,actor_name,action,target,before_json,after_json,created_at) VALUES(?,?,?,?,?,?,?)",
  ).run(
    actor.id,
    actor.username,
    action,
    target,
    before ? JSON.stringify(before) : null,
    after ? JSON.stringify(after) : null,
    timestamp(),
  );
}
export function insertSlot(db, rank, slot) {
  db.prepare(
    "INSERT INTO callsigns(id,rank_id,number,slot) VALUES(?,?,?,?)",
  ).run(id(), rank.id, `${rank.code}-${String(slot).padStart(3, "0")}`, slot);
}
export function listPersonnel(db) {
  return db
    .prepare(
      `SELECT p.*,r.label rank,r.code rank_code,c.number callsign,c.id callsign_id FROM personnel p JOIN ranks r ON r.id=p.rank_id LEFT JOIN callsigns c ON c.personnel_id=p.id ORDER BY r.position,p.discord_name`,
    )
    .all();
}
export function listCallsigns(db) {
  return db
    .prepare(
      `SELECT c.*,r.label rank,r.code rank_code,r.position, p.discord_name,p.discord_id,p.active FROM callsigns c JOIN ranks r ON r.id=c.rank_id LEFT JOIN personnel p ON p.id=c.personnel_id ORDER BY r.position,c.slot`,
    )
    .all();
}
export function savePersonnel(db, actor, body, existingId) {
  const row = {
    id: existingId || id(),
    discord_id: snowflake(body.discordId),
    discord_name: text(body.discordName, "Discord-naam", 80),
    rank_id: text(body.rankId, "Rang", 40),
    active: body.active === false ? 0 : 1,
  };
  const before = existingId
    ? db.prepare("SELECT * FROM personnel WHERE id=?").get(existingId)
    : null;
  requireValue(!existingId || before, 404, "Personeelslid niet gevonden.");
  requireValue(
    db.prepare("SELECT id FROM ranks WHERE id=?").get(row.rank_id),
    400,
    "Deze rang bestaat niet.",
  );
  const selected = body.callsignId
    ? db.prepare("SELECT * FROM callsigns WHERE id=?").get(body.callsignId)
    : null;
  if (body.callsignId) {
    requireValue(
      selected && selected.rank_id === row.rank_id,
      400,
      "Roepnummer en rang komen niet overeen.",
    );
    requireValue(
      !selected.personnel_id || selected.personnel_id === row.id,
      409,
      "Dit roepnummer is al toegewezen.",
    );
  }
  const place = text(body.place ?? "", "Plaats", 100, true);
  row.place = place;
  return transaction(db, () => {
    if (existingId)
      db.prepare(
        "UPDATE personnel SET discord_id=?,discord_name=?,rank_id=?,active=?,place=?,callsign_issue=NULL,updated_at=? WHERE id=?",
      ).run(
        row.discord_id,
        row.discord_name,
        row.rank_id,
        row.active,
        place,
        timestamp(),
        row.id,
      );
    else
      db.prepare(
        "INSERT INTO personnel(id,discord_id,discord_name,rank_id,active,created_at,updated_at,place) VALUES(?,?,?,?,?,?,?,?)",
      ).run(
        row.id,
        row.discord_id,
        row.discord_name,
        row.rank_id,
        row.active,
        timestamp(),
        timestamp(),
        place,
      );
    db.prepare(
      "UPDATE callsigns SET personnel_id=NULL,place='' WHERE personnel_id=?",
    ).run(row.id);
    if (selected)
      db.prepare("UPDATE callsigns SET personnel_id=?,place=? WHERE id=?").run(
        row.id,
        place,
        selected.id,
      );
    db.prepare("UPDATE personnel SET callsign_issue=NULL WHERE id=?").run(
      row.id,
    );
    audit(
      db,
      actor,
      existingId ? "personeel.gewijzigd" : "personeel.toegevoegd",
      row.id,
      before,
      { ...row, callsignId: selected?.id || null, place },
    );
    return row;
  });
}
export function saveCallsign(db, actor, body, existingId) {
  const before = existingId
    ? db.prepare("SELECT * FROM callsigns WHERE id=?").get(existingId)
    : null;
  requireValue(!existingId || before, 404, "Roepnummer niet gevonden.");
  const rankId = before?.rank_id || text(body.rankId, "Rang", 40);
  const rank = db.prepare("SELECT * FROM ranks WHERE id=?").get(rankId);
  requireValue(rank, 400, "Rang bestaat niet.");
  const number = text(body.number, "Roepnummer", 40);
  requireValue(
    !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(number),
    400,
    "Gebruik één regel voor het roepnummer.",
  );
  const person = body.personnelId
    ? db.prepare("SELECT * FROM personnel WHERE id=?").get(body.personnelId)
    : null;
  if (body.personnelId) {
    requireValue(
      person && person.rank_id === rankId,
      400,
      "Personeelslid heeft een andere rang.",
    );
    const assigned = db
      .prepare("SELECT id FROM callsigns WHERE personnel_id=?")
      .get(person.id);
    requireValue(
      !assigned || assigned.id === existingId,
      409,
      "Dit personeelslid heeft al een roepnummer.",
    );
  }
  const place = text(body.place ?? "", "Plaats", 100, true);
  const target = existingId || id();
  return transaction(db, () => {
    if (before)
      db.prepare(
        "UPDATE callsigns SET number=?,personnel_id=?,place=? WHERE id=?",
      ).run(number, person?.id || null, person ? place : "", target);
    else {
      const slot =
        (db
          .prepare("SELECT MAX(slot) value FROM callsigns WHERE rank_id=?")
          .get(rankId).value || 0) + 1;
      requireValue(slot <= 500, 400, "Maximaal 500 regels per rang.");
      db.prepare("INSERT INTO callsigns VALUES(?,?,?,?,?,?)").run(
        target,
        rankId,
        number,
        slot,
        person?.id || null,
        person ? place : "",
      );
      db.prepare("UPDATE ranks SET capacity=? WHERE id=?").run(slot, rankId);
    }
    if (person)
      db.prepare(
        "UPDATE personnel SET callsign_issue=NULL,place=? WHERE id=?",
      ).run(place, person.id);
    audit(
      db,
      actor,
      before ? "roepnummer.gewijzigd" : "roepnummer.toegevoegd",
      target,
      before,
      { number, personnelId: person?.id || null, place },
    );
    return target;
  });
}
export function saveRank(db, actor, body, existingId) {
  const before = existingId
    ? db.prepare("SELECT * FROM ranks WHERE id=?").get(existingId)
    : null;
  requireValue(!existingId || before, 404, "Rang niet gevonden.");
  const label = text(body.label, "Rangnaam", 80),
    code = before?.code || text(body.code, "Nummerreeks", 2),
    capacity = positive(body.capacity, "Aantal regels", 500);
  requireValue(
    /^\d{2}$/.test(code),
    400,
    "Nummerreeks moet uit twee cijfers bestaan.",
  );
  const roleId = body.discordRoleId
    ? snowflake(body.discordRoleId, "Discord-rangrol")
    : null;
  if (roleId)
    requireValue(
      !db
        .prepare("SELECT id FROM ranks WHERE discord_role_id=? AND id<>?")
        .get(roleId, existingId || ""),
      409,
      "Deze Discord-rol is al gekoppeld aan een rang.",
    );
  const rank = {
    id: existingId || id(),
    code,
    label,
    capacity,
    special: Number(code) <= 5 ? 1 : 0,
    position: before?.position ?? Number(code),
    discordRoleId: roleId,
  };
  return transaction(db, () => {
    if (before) {
      const occupied = db
        .prepare(
          "SELECT id FROM callsigns WHERE rank_id=? AND slot>? AND personnel_id IS NOT NULL",
        )
        .get(rank.id, capacity);
      requireValue(
        !occupied,
        409,
        "Maak toegewezen regels eerst vrij voordat je de reeks verkleint.",
      );
      db.prepare("DELETE FROM callsigns WHERE rank_id=? AND slot>?").run(
        rank.id,
        capacity,
      );
      db.prepare("UPDATE ranks SET label=?,capacity=? WHERE id=?").run(
        label,
        capacity,
        rank.id,
      );
    } else
      db.prepare(
        "INSERT INTO ranks(id,code,label,capacity,special,position) VALUES(?,?,?,?,?,?)",
      ).run(rank.id, code, label, capacity, rank.special, rank.position);
    db.prepare("UPDATE ranks SET discord_role_id=? WHERE id=?").run(
      roleId,
      rank.id,
    );
    const existing = new Set(
      db
        .prepare("SELECT slot FROM callsigns WHERE rank_id=?")
        .all(rank.id)
        .map((x) => x.slot),
    );
    for (let i = 1; i <= capacity; i++)
      if (!existing.has(i)) insertSlot(db, rank, i);
    audit(
      db,
      actor,
      before ? "rang.gewijzigd" : "rang.toegevoegd",
      rank.id,
      before,
      rank,
    );
    return rank;
  });
}
export function sqliteError(error) {
  if (
    error.code === "ERR_SQLITE_ERROR" &&
    /UNIQUE constraint/.test(error.message)
  )
    return new HttpError(
      409,
      "Deze naam, Discord-ID of dit roepnummer bestaat al.",
    );
  return error;
}
