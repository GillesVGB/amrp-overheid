import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./database.mjs";

const LOCK_ID = 731904211;
const META_TABLE = "amrp_portal_meta";
const LEGACY_TABLE = "amrp_portal_state";
const runtimeTables = new Set([
  "sessions",
  "auth_flows",
  "signup_flows",
  "discord_login_flows",
  "rate_limits",
  "deleted_callsigns",
  "user_preferences",
  "form_drafts",
]);
const identifier = (value) => '"' + String(value).replaceAll('"', '""') + '"';
const literal = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const tableName = (name) => `"public".${identifier(name)}`;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const stableJson = (value) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
const objectName = (value) =>
  value.length <= 60
    ? value
    : value.slice(0, 43) + "_" + hash(value).slice(0, 16);

function pgType(type = "") {
  if (/INT/i.test(type)) return "BIGINT";
  if (/CHAR|CLOB|TEXT/i.test(type)) return "TEXT";
  if (/BLOB/i.test(type) || !type) return "BYTEA";
  if (/REAL|FLOA|DOUB/i.test(type)) return "DOUBLE PRECISION";
  return "NUMERIC";
}

function pgDefault(value) {
  if (value === null || value === undefined) return "";
  // Only portable literals are copied. SQLite still applies all other defaults.
  if (/^(?:NULL|-?\d+(?:\.\d+)?|'(?:[^']|'')*')$/i.test(value))
    return " DEFAULT " + value;
  return "";
}

function checks(sql) {
  const result = [];
  const expression = /\bCHECK\s*\(/gi;
  let match;
  while ((match = expression.exec(sql))) {
    let depth = 1,
      quote = false,
      end = expression.lastIndex;
    for (; end < sql.length && depth; end++) {
      if (sql[end] === "'") {
        if (quote && sql[end + 1] === "'") {
          end++;
          continue;
        }
        quote = !quote;
      }
      if (!quote && sql[end] === "(") depth++;
      if (!quote && sql[end] === ")") depth--;
    }
    const body = sql.slice(expression.lastIndex, end - 1);
    // SQLite-specific functions and collations cannot be installed as PG checks.
    const withoutStrings = body.replace(/'(?:[^']|'')*'/g, "''");
    const hasFunction = [
      ...withoutStrings.matchAll(/\b([A-Za-z_]\w*)\s*\(/g),
    ].some((item) => item[1].toUpperCase() !== "IN");
    if (
      !/[;]|\b(?:COLLATE|GLOB|REGEXP)\b/i.test(withoutStrings) &&
      !hasFunction
    )
      result.push(body);
    expression.lastIndex = end;
  }
  return result;
}

function inspect(db) {
  const schema = db
    .prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'view' THEN 2 ELSE 3 END,name",
    )
    .all();
  const tables = schema
    .filter((item) => item.type === "table")
    .map((entry) => {
      if (/^CREATE\s+VIRTUAL\s+TABLE/i.test(entry.sql))
        throw new Error(
          "Virtuele SQLite-tabellen kunnen niet naar PostgreSQL worden gemigreerd.",
        );
      const columns = db
        .prepare(`PRAGMA table_info(${identifier(entry.name)})`)
        .all();
      const indexes = db
        .prepare(`PRAGMA index_list(${identifier(entry.name)})`)
        .all()
        .map((index) => ({
          ...index,
          columns: db
            .prepare(`PRAGMA index_xinfo(${identifier(index.name)})`)
            .all()
            .filter((column) => column.key),
        }));
      const rows = db.prepare(`SELECT * FROM ${identifier(entry.name)}`).all();
      return {
        ...entry,
        columns,
        indexes,
        foreignKeys: db
          .prepare(`PRAGMA foreign_key_list(${identifier(entry.name)})`)
          .all(),
        rows,
      };
    });
  const sequences = db
    .prepare("SELECT name FROM sqlite_master WHERE name='sqlite_sequence'")
    .get()
    ? db.prepare("SELECT name,seq FROM sqlite_sequence").all()
    : [];
  return { schema, tables, sequences };
}

function encodeValue(value, column) {
  if (value === null) return null;
  if (pgType(column.type) === "BYTEA")
    return "\\x" + Buffer.from(value).toString("hex");
  if (typeof value === "bigint") return value.toString();
  return value;
}

function decodeValue(value, column) {
  if (value === null || value === undefined) return null;
  const type = pgType(column.type);
  if (type === "BYTEA") {
    if (typeof value !== "string" || !/^\\x(?:[\da-f]{2})*$/i.test(value))
      throw new Error(`Ongeldige binaire waarde in ${column.name}.`);
    return Buffer.from(value.slice(2), "hex");
  }
  if (type === "BIGINT" || type === "DOUBLE PRECISION" || type === "NUMERIC") {
    const number = Number(value);
    if (
      !Number.isFinite(number) ||
      (type === "BIGINT" && !Number.isSafeInteger(number))
    )
      throw new Error(
        `Numerieke waarde in ${column.name} kan niet veilig worden geladen.`,
      );
    return number;
  }
  return String(value);
}

function tableDigest(table) {
  const rows = table.rows
    .map((row) =>
      JSON.stringify(
        table.columns.map((column) => encodeValue(row[column.name], column)),
      ),
    )
    .sort();
  return hash(JSON.stringify({ columns: table.columns, rows }));
}

function applicationDigest(snapshot) {
  return hash(
    JSON.stringify(
      snapshot.tables
        .filter((table) => !runtimeTables.has(table.name))
        .map((table) => [table.name, tableDigest(table)]),
    ),
  );
}

async function loadRows(client, schema) {
  const tables = schema.filter((entry) => entry.type === "table");
  if (!tables.length)
    throw new Error("De PostgreSQL-portaalstructuur ontbreekt.");
  const parts = tables.map(
    ({ name }) =>
      `${literal(name)},COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM ${tableName(name)} r),'[]'::jsonb)`,
  );
  const result = await client.query(
    `/* amrp:load */ SELECT jsonb_build_object(${parts.join(",")}) AS data`,
  );
  return result.rows[0].data;
}

function restoreSqlite(file, schema, rows, sequences) {
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA foreign_keys=OFF; BEGIN");
    for (const entry of schema.filter((item) => item.type === "table")) {
      db.exec(entry.sql);
      const columns = db
        .prepare(`PRAGMA table_info(${identifier(entry.name)})`)
        .all();
      const insert = db.prepare(
        `INSERT INTO ${identifier(entry.name)}(${columns.map((column) => identifier(column.name)).join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
      );
      for (const row of rows[entry.name] || [])
        insert.run(
          ...columns.map((column) => decodeValue(row[column.name], column)),
        );
    }
    if (
      db
        .prepare("SELECT name FROM sqlite_master WHERE name='sqlite_sequence'")
        .get()
    ) {
      for (const sequence of sequences || []) {
        const current = db
          .prepare("SELECT seq FROM sqlite_sequence WHERE name=?")
          .get(sequence.name);
        if (!current)
          db.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)").run(
            sequence.name,
            Number(sequence.seq),
          );
        else if (Number(sequence.seq) > current.seq)
          db.prepare("UPDATE sqlite_sequence SET seq=? WHERE name=?").run(
            Number(sequence.seq),
            sequence.name,
          );
      }
    }
    // Indexes and triggers are restored after rows, so replay cannot create audit
    // entries or run application-side trigger effects a second time.
    for (const entry of schema.filter((item) => item.type !== "table"))
      db.exec(entry.sql);
    db.exec("COMMIT");
    const invalid = db.prepare("PRAGMA foreign_key_check").get();
    if (invalid)
      throw new Error(
        `Ongeldige relatie in PostgreSQL-tabel ${invalid.table}.`,
      );
  } finally {
    db.close();
  }
}

async function ensureSchema(client, snapshot) {
  const statements = [];
  for (const table of snapshot.tables) {
    const primaryKey = table.columns
      .filter((column) => column.pk)
      .sort((a, b) => a.pk - b.pk);
    const definitions = table.columns.map((column) => {
      const identity =
        primaryKey.length === 1 &&
        column.pk &&
        /AUTOINCREMENT/i.test(table.sql);
      return `${identifier(column.name)} ${pgType(column.type)}${identity ? " GENERATED BY DEFAULT AS IDENTITY" : pgDefault(column.dflt_value)}${column.notnull ? " NOT NULL" : ""}`;
    });
    if (primaryKey.length)
      definitions.push(
        `PRIMARY KEY(${primaryKey.map((column) => identifier(column.name)).join(",")})`,
      );
    for (const check of checks(table.sql)) definitions.push(`CHECK(${check})`);
    statements.push(
      `CREATE TABLE IF NOT EXISTS ${tableName(table.name)}(${definitions.join(",")})`,
    );
    // Schema additions are data-first: new NOT NULL columns receive the values
    // generated by openDatabase before enforcing nullability below.
    for (const column of table.columns)
      statements.push(
        `ALTER TABLE ${tableName(table.name)} ADD COLUMN IF NOT EXISTS ${identifier(column.name)} ${pgType(column.type)}${pgDefault(column.dflt_value)}`,
      );
  }
  if (statements.length) await client.query(statements.join(";\n"));
}

async function ensureConstraints(client, snapshot) {
  const statements = [];
  for (const table of snapshot.tables) {
    for (const column of table.columns.filter((entry) => entry.notnull))
      statements.push(
        `ALTER TABLE ${tableName(table.name)} ALTER COLUMN ${identifier(column.name)} SET NOT NULL`,
      );
    for (const index of table.indexes.filter(
      (entry) => entry.origin !== "pk" && !entry.partial,
    )) {
      if (index.columns.some((column) => !column.name)) continue;
      const columns = index.columns.map((column) =>
        column.coll === "NOCASE"
          ? `lower(${identifier(column.name)})`
          : identifier(column.name),
      );
      const name = objectName(`amrp_${table.name}_${index.name}`);
      statements.push(
        `CREATE ${index.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${identifier(name)} ON ${tableName(table.name)}(${columns.join(",")})`,
      );
    }
    const groups = Map.groupBy(table.foreignKeys, (key) => key.id);
    for (const [keyId, keys] of groups) {
      keys.sort((a, b) => a.seq - b.seq);
      const constraint = objectName(`amrp_${table.name}_fk_${keyId}`);
      // The SQLite unit of work already performs CASCADE/SET NULL. PostgreSQL
      // checks the final state at commit, avoiding cascades during bulk replace.
      const sql = `ALTER TABLE ${tableName(table.name)} ADD CONSTRAINT ${identifier(constraint)} FOREIGN KEY(${keys.map((key) => identifier(key.from)).join(",")}) REFERENCES ${tableName(keys[0].table)}(${keys.map((key) => identifier(key.to)).join(",")}) DEFERRABLE INITIALLY DEFERRED`;
      statements.push(
        `DO $amrp$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname=${literal(constraint)} AND conrelid=${literal(`public.${table.name}`)}::regclass) THEN ${sql}; END IF; END $amrp$`,
      );
    }
  }
  if (statements.length) await client.query(statements.join(";\n"));
}

async function saveRows(client, snapshot, before) {
  const prior = new Map(
    before?.tables.map((table) => [table.name, tableDigest(table)]) || [],
  );
  const changed = snapshot.tables.filter(
    (table) => prior.get(table.name) !== tableDigest(table),
  );
  if (changed.length) {
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query(
      changed
        .map((table) => `DELETE FROM ${tableName(table.name)}`)
        .join(";\n"),
    );
    for (const table of changed) {
      if (!table.rows.length) continue;
      const columns = table.columns
        .map((column) => identifier(column.name))
        .join(",");
      const rows = table.rows.map((row) =>
        Object.fromEntries(
          table.columns.map((column) => [
            column.name,
            encodeValue(row[column.name], column),
          ]),
        ),
      );
      await client.query(
        `/* amrp:save ${table.name} */ INSERT INTO ${tableName(table.name)}(${columns}) SELECT ${columns} FROM jsonb_populate_recordset(NULL::${tableName(table.name)},$1::jsonb)`,
        [JSON.stringify(rows)],
      );
    }
  }
  for (const table of snapshot.tables.filter(
    (entry) =>
      /AUTOINCREMENT/i.test(entry.sql) &&
      (changed.includes(entry) ||
        snapshot.sequences.find((sequence) => sequence.name === entry.name)
          ?.seq !==
          before?.sequences.find((sequence) => sequence.name === entry.name)
            ?.seq),
  )) {
    const key = table.columns.find((column) => column.pk);
    const sequence =
      snapshot.sequences.find((entry) => entry.name === table.name)?.seq || 0;
    const next =
      table.rows.reduce(
        (maximum, row) => Math.max(maximum, Number(row[key.name]) || 0),
        Number(sequence),
      ) + 1;
    await client.query(
      "SELECT setval(pg_get_serial_sequence($1,$2),$3,false)",
      [`public.${table.name}`, key.name, next],
    );
  }
  return changed.length;
}

/**
 * PostgreSQL tables are authoritative. SQLite is an isolated compatibility unit
 * of work, rebuilt from those rows per request. The old snapshot is retained as
 * a migration backup and is never updated. Each request is serialised by the
 * existing advisory lock; this is deliberately not a high-throughput DB adapter.
 * callback's second argument contains the saved live-update revision.
 */
export async function withPostgresPortalState(config, callback, { pool } = {}) {
  if (!pool) throw new Error("Een PostgreSQL-pool is vereist.");
  const client = await pool.connect();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "amrp-relational-"));
  const file = path.join(dataDir, "portal.sqlite");
  let db,
    transactionOpen = false;
  try {
    await client.query("BEGIN");
    transactionOpen = true;
    await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [LOCK_ID]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${tableName(META_TABLE)}(id SMALLINT PRIMARY KEY CHECK(id=1),schema_version INTEGER NOT NULL DEFAULT 1,revision BIGINT NOT NULL DEFAULT 1,sqlite_schema JSONB NOT NULL,sqlite_sequences JSONB NOT NULL DEFAULT '[]'::jsonb,migrated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
    );
    const saved = (
      await client.query(
        `SELECT revision,sqlite_schema,sqlite_sequences FROM ${tableName(META_TABLE)} WHERE id=1`,
      )
    ).rows[0];
    let before;
    if (saved) {
      const rows = await loadRows(client, saved.sqlite_schema);
      if (!rows.settings?.some((row) => Number(row.id) === 1))
        throw new Error(
          "De bestaande PostgreSQL-instellingen ontbreken; automatisch opnieuw vullen is geblokkeerd.",
        );
      restoreSqlite(file, saved.sqlite_schema, rows, saved.sqlite_sequences);
      const restored = new DatabaseSync(file);
      try {
        before = inspect(restored);
      } finally {
        restored.close();
      }
    } else {
      const legacy = (
        await client.query(
          "SELECT to_regclass('public.amrp_portal_state') AS legacy",
        )
      ).rows[0]?.legacy;
      const image = legacy
        ? (
            await client.query(
              `SELECT sqlite_image FROM ${tableName(LEGACY_TABLE)} WHERE id=1`,
            )
          ).rows[0]?.sqlite_image
        : null;
      if (image) fs.writeFileSync(file, image, { mode: 0o600 });
      // Never overwrite independent existing tables when a migration marker is
      // absent. An administrator must resolve that ambiguous state explicitly.
      const occupied = await client.query(
        "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT IN ('amrp_portal_state','amrp_portal_meta')",
      );
      const existing = new Set(occupied.rows.map((row) => row.tablename));
      if (existing.has("users") || existing.has("settings"))
        throw new Error(
          "Er bestaan al portaal-tabellen zonder migratiemarkering; migratie is veilig gestopt.",
        );
    }
    db = openDatabase({ ...config, dataDir });
    const baseline = before || inspect(db);
    const revision = Number(saved?.revision || 0);
    const result = await callback(db, { revision });
    if (db.prepare("PRAGMA foreign_key_check").get())
      throw new Error("Een databasewijziging bevat een ongeldige relatie.");
    const after = inspect(db);
    const schemaChanged =
      !saved || stableJson(saved.sqlite_schema) !== stableJson(after.schema);
    if (schemaChanged) await ensureSchema(client, after);
    const changedTables = await saveRows(client, after, before);
    if (schemaChanged) await ensureConstraints(client, after);
    const nextRevision =
      revision +
      (!saved || applicationDigest(baseline) !== applicationDigest(after)
        ? 1
        : 0);
    if (
      changedTables ||
      schemaChanged ||
      stableJson(saved?.sqlite_sequences) !== stableJson(after.sequences)
    )
      await client.query(
        `INSERT INTO ${tableName(META_TABLE)}(id,revision,sqlite_schema,sqlite_sequences) VALUES(1,$1,$2::jsonb,$3::jsonb) ON CONFLICT(id) DO UPDATE SET revision=EXCLUDED.revision,sqlite_schema=EXCLUDED.sqlite_schema,sqlite_sequences=EXCLUDED.sqlite_sequences,updated_at=NOW()`,
        [
          nextRevision,
          JSON.stringify(after.schema),
          JSON.stringify(after.sequences),
        ],
      );
    await client.query("COMMIT");
    transactionOpen = false;
    return result;
  } catch (error) {
    if (transactionOpen) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    if (db) db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    client.release();
  }
}
