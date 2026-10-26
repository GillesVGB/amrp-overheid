import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDatabase } from "../server/database.mjs";
import { withPostgresPortalState } from "../server/postgres-state.mjs";

function createPool(image = null) {
  let state = { meta: null, rows: {}, legacy: image };
  let lock = Promise.resolve();
  const queries = [];
  return {
    get state() {
      return state;
    },
    queries,
    async connect() {
      let pending,
        unlock,
        pendingConstraintChecks = false;
      return {
        async query(sql, values = []) {
          queries.push(sql);
          if (sql === "BEGIN") return { rows: [] };
          if (sql.includes("pg_advisory_xact_lock")) {
            const previous = lock;
            lock = new Promise((resolve) => {
              unlock = resolve;
            });
            await previous;
            pending = structuredClone(state);
            return { rows: [] };
          }
          if (sql === "COMMIT") {
            state = pending;
            unlock();
            unlock = null;
            return { rows: [] };
          }
          if (sql === "ROLLBACK") {
            unlock?.();
            unlock = null;
            return { rows: [] };
          }
          if (sql.startsWith("SELECT revision,sqlite_schema"))
            return { rows: pending.meta ? [pending.meta] : [] };
          if (sql.includes("to_regclass"))
            return {
              rows: [{ legacy: pending.legacy ? "amrp_portal_state" : null }],
            };
          if (sql.startsWith("SELECT sqlite_image"))
            return {
              rows: pending.legacy ? [{ sqlite_image: pending.legacy }] : [],
            };
          if (sql.includes("FROM pg_tables"))
            return {
              rows: Object.keys(pending.rows).map((tablename) => ({
                tablename,
              })),
            };
          if (sql.startsWith("/* amrp:load */"))
            return { rows: [{ data: structuredClone(pending.rows) }] };
          if (sql.startsWith("DELETE FROM")) {
            for (const [, name] of sql.matchAll(
              /DELETE FROM "public"\."([^"]+)"/g,
            ))
              pending.rows[name] = [];
            return { rows: [] };
          }
          const save = sql.match(/^\/\* amrp:save (\w+) \*\//);
          if (save) {
            pending.rows[save[1]] = JSON.parse(values[0]);
            if (pending.meta) pendingConstraintChecks = true;
            return { rows: [] };
          }
          if (sql === "SET CONSTRAINTS ALL IMMEDIATE") {
            pendingConstraintChecks = false;
            return { rows: [] };
          }
          // Model PostgreSQL's deferred-trigger restriction during a migration.
          if (pendingConstraintChecks && /ALTER TABLE/.test(sql))
            throw new Error(
              "cannot ALTER TABLE because it has pending trigger events",
            );
          if (sql.startsWith('INSERT INTO "public"."amrp_portal_meta"')) {
            pending.meta = {
              revision: values[0],
              sqlite_schema: JSON.parse(values[1]),
              sqlite_sequences: JSON.parse(values[2]),
            };
            return { rows: [] };
          }
          if (
            /^(?:CREATE TABLE|ALTER TABLE|DO \$amrp\$|CREATE (?:UNIQUE )?INDEX|SET CONSTRAINTS|SELECT setval)/.test(
              sql,
            )
          )
            return { rows: [] };
          throw new Error("Unexpected query: " + sql);
        },
        release() {
          unlock?.();
        },
      };
    },
  };
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "amrp-pg-test-"));
  return {
    root,
    config: {
      dataDir: root,
      roles: { owner: [], admin: [], police: [], command: [], ambulance: [] },
    },
    close() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("Supabase tables block the public Data API while the owning backend persists data", async () => {
  const local = fixture(),
    pool = createPool();
  local.config.protectPublicTables = true;
  try {
    await withPostgresPortalState(local.config, () => {}, { pool });
    const protection = pool.queries.find((sql) =>
      sql.includes("ENABLE ROW LEVEL SECURITY"),
    );
    assert.ok(protection);
    for (const table of [
      "amrp_portal_meta",
      "users",
      "sessions",
      "settings",
      "personnel",
      "callsigns",
    ]) {
      assert.ok(
        protection.includes(
          `ALTER TABLE "public"."${table}" ENABLE ROW LEVEL SECURITY`,
        ),
      );
      assert.ok(
        protection.includes(
          `REVOKE ALL ON TABLE "public"."${table}" FROM PUBLIC,anon,authenticated`,
        ),
      );
    }
    await withPostgresPortalState(
      local.config,
      (db) =>
        db
          .prepare("UPDATE settings SET value=? WHERE id=1")
          .run('{"title":"Persisted"}'),
      { pool },
    );
    assert.equal(pool.state.rows.settings[0].value, '{"title":"Persisted"}');
  } finally {
    local.close();
  }
});

test("individual PostgreSQL tables persist writes, avoid read/auth revision loops and roll back failures", async () => {
  const local = fixture(),
    pool = createPool();
  const run = (callback) =>
    withPostgresPortalState(local.config, callback, { pool });
  try {
    const rankIds = await run((db) =>
      db.prepare("SELECT id FROM ranks ORDER BY position").all(),
    );
    assert.ok(pool.state.rows.users);
    assert.ok(pool.state.rows.personnel);
    assert.ok(pool.state.rows.callsigns.length);
    assert.equal(pool.state.meta.revision, 1);
    await run((db, meta) => {
      assert.equal(meta.revision, 1);
      assert.deepEqual(
        db.prepare("SELECT id FROM ranks ORDER BY position").all(),
        rankIds,
      );
      db.prepare(
        "INSERT INTO signup_flows(hash,username,expires_at) VALUES(?,?,?)",
      ).run("flow", "agent", Date.now() + 10000);
    });
    assert.equal(pool.state.meta.revision, 1);
    await run((db) =>
      db
        .prepare("UPDATE settings SET value=? WHERE id=1")
        .run('{"name":"Shared"}'),
    );
    assert.equal(pool.state.meta.revision, 2);
    await assert.rejects(
      run((db) => {
        db.prepare("UPDATE settings SET value='discard' WHERE id=1").run();
        throw new Error("Request failed");
      }),
      /Request failed/,
    );
    assert.equal(pool.state.meta.revision, 2);
    assert.equal(
      await run(
        (db) => db.prepare("SELECT value FROM settings WHERE id=1").get().value,
      ),
      '{"name":"Shared"}',
    );
    assert.equal(pool.state.meta.revision, 2);
    assert.ok(
      pool.queries.some((sql) => sql.includes("jsonb_populate_recordset")),
    );
    assert.ok(
      !pool.queries.some((sql) => /INSERT INTO.*amrp_portal_state/.test(sql)),
    );
  } finally {
    local.close();
  }
});

test("unchanged reads commit without row writes while DDL-only changes remain durable", async () => {
  const local = fixture(),
    pool = createPool();
  const run = (callback) =>
    withPostgresPortalState(local.config, callback, { pool });
  try {
    await run(() => {});
    const revision = pool.state.meta.revision;
    const queryStart = pool.queries.length;
    await run((db, meta) => {
      assert.equal(meta.revision, revision);
      assert.ok(db.prepare("SELECT COUNT(*) n FROM callsigns").get().n);
      assert.equal(db.prepare("SELECT total_changes() n").get().n, 0);
    });
    assert.equal(pool.state.meta.revision, revision);
    assert.ok(
      !pool.queries
        .slice(queryStart)
        .some((sql) => /^(?:DELETE FROM|INSERT INTO|\/\* amrp:save)/.test(sql)),
    );
    await run((db) => {
      db.exec("CREATE TABLE schema_only_change(id TEXT PRIMARY KEY)");
      // SQLite DDL does not count as a changed data row.
      assert.equal(db.prepare("SELECT total_changes() n").get().n, 0);
    });
    assert.equal(pool.state.meta.revision, revision + 1);
    assert.ok(
      pool.state.meta.sqlite_schema.some(
        (entry) => entry.name === "schema_only_change",
      ),
    );
    assert.deepEqual(pool.state.rows.schema_only_change, []);
    assert.equal(
      await run(
        (db) => db.prepare("SELECT COUNT(*) n FROM schema_only_change").get().n,
      ),
      0,
    );
  } finally {
    local.close();
  }
});

test("initialization migrations persist even when the request writes no data", async () => {
  const local = fixture(),
    pool = createPool();
  const run = (callback) =>
    withPostgresPortalState(local.config, callback, { pool });
  try {
    await run((db) => {
      db.prepare(
        "INSERT INTO users(id,username,discord_id,password_hash,created_at) VALUES(?,?,?,?,?)",
      ).run("migrate", "migrate", "990000000000000002", "hash", "2026-01-01");
      db.prepare(
        "INSERT INTO user_preferences(user_id,wallpaper,updated_at) VALUES(?,?,?)",
      ).run("migrate", "amsterdam", "2026-01-01");
    });
    const stored = pool.state.meta.sqlite_schema.find(
      (entry) => entry.name === "user_preferences",
    );
    stored.sql = stored.sql.replace(
      ",theme TEXT NOT NULL DEFAULT 'light'",
      "",
    );
    for (const row of pool.state.rows.user_preferences) delete row.theme;
    const revision = pool.state.meta.revision;
    await run((db) => {
      assert.equal(db.prepare("SELECT total_changes() n").get().n, 0);
      assert.equal(
        db.prepare("SELECT theme FROM user_preferences").get().theme,
        "light",
      );
    });
    assert.equal(pool.state.meta.revision, revision);
    assert.equal(pool.state.rows.user_preferences[0].theme, "light");
    assert.ok(
      pool.state.meta.sqlite_schema
        .find((entry) => entry.name === "user_preferences")
        .sql.includes("theme TEXT NOT NULL DEFAULT 'light'"),
    );
  } finally {
    local.close();
  }
});

test("legacy snapshot migrates atomically with accounts, indexes, blobs, triggers and audit sequences intact", async () => {
  const local = fixture();
  try {
    const db = openDatabase(local.config);
    db.prepare(
      "INSERT INTO users(id,username,discord_id,password_hash,created_at) VALUES(?,?,?,?,?)",
    ).run(
      "owner",
      "Gilles",
      "960090714950225970",
      "existing-hash",
      "2026-01-01",
    );
    const insert = db.prepare(
      "INSERT INTO audit(actor_id,actor_name,action,target,created_at) VALUES('owner','Gilles','test','test','2026-01-01')",
    );
    insert.run();
    insert.run();
    db.exec(
      "DELETE FROM audit WHERE id=2; CREATE TABLE test_assets(id TEXT PRIMARY KEY,label TEXT NOT NULL COLLATE NOCASE UNIQUE,content BLOB); CREATE TRIGGER assets_audit AFTER UPDATE ON test_assets BEGIN INSERT INTO audit(actor_id,actor_name,action,target,created_at) VALUES('owner','Gilles','asset','test','2026-01-01'); END;",
    );
    db.prepare("INSERT INTO test_assets VALUES(?,?,?)").run(
      "one",
      "Handbook",
      Buffer.from([0, 1, 255]),
    );
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
    const image = fs.readFileSync(path.join(local.root, "portal.sqlite"));
    const pool = createPool(image);
    const run = (callback) =>
      withPostgresPortalState(local.config, callback, { pool });
    await assert.rejects(
      run(() => {
        throw new Error("abort migration");
      }),
      /abort migration/,
    );
    assert.equal(pool.state.meta, null);
    assert.deepEqual(Buffer.from(pool.state.legacy), image);
    await run((requestDb) => {
      assert.equal(
        requestDb
          .prepare("SELECT password_hash FROM users WHERE id='owner'")
          .get().password_hash,
        "existing-hash",
      );
      const audit = requestDb
        .prepare(
          "INSERT INTO audit(actor_id,actor_name,action,target,created_at) VALUES('owner','Gilles','migrated','test','2026-01-01')",
        )
        .run();
      assert.equal(Number(audit.lastInsertRowid), 3);
    });
    assert.equal(pool.state.rows.users[0].username, "Gilles");
    assert.deepEqual(Buffer.from(pool.state.legacy), image);
    await run((requestDb) => {
      assert.deepEqual(
        Buffer.from(
          requestDb
            .prepare("SELECT content FROM test_assets WHERE id='one'")
            .get().content,
        ),
        Buffer.from([0, 1, 255]),
      );
      requestDb
        .prepare("UPDATE test_assets SET label='Updated' WHERE id='one'")
        .run();
      assert.equal(
        requestDb.prepare("SELECT MAX(id) AS id FROM audit").get().id,
        4,
      );
      assert.throws(
        () =>
          requestDb
            .prepare("INSERT INTO test_assets VALUES('two','updated',NULL)")
            .run(),
        /UNIQUE/,
      );
    });
    assert.equal(pool.state.rows.audit.length, 3);
    assert.ok(pool.queries.some((sql) => sql.includes('lower("label")')));
    assert.ok(
      pool.queries.some((sql) => sql.includes("DEFERRABLE INITIALLY DEFERRED")),
    );
  } finally {
    local.close();
  }
});

test("simultaneous requests serialize against committed relational state", async () => {
  const local = fixture(),
    pool = createPool();
  const run = (callback) =>
    withPostgresPortalState(local.config, callback, { pool });
  try {
    await run((db) =>
      db.prepare("UPDATE settings SET value='0' WHERE id=1").run(),
    );
    await Promise.all(
      Array.from({ length: 4 }, () =>
        run(async (db) => {
          const value = Number(
            db.prepare("SELECT value FROM settings WHERE id=1").get().value,
          );
          await Promise.resolve();
          db.prepare("UPDATE settings SET value=? WHERE id=1").run(
            String(value + 1),
          );
        }),
      ),
    );
    assert.equal(
      await run(
        (db) => db.prepare("SELECT value FROM settings WHERE id=1").get().value,
      ),
      "4",
    );
  } finally {
    local.close();
  }
});

test("existing account wallpaper survives the theme-column migration and personal appearance persists in PostgreSQL", async () => {
  const local = fixture(),
    pool = createPool();
  const run = (callback) =>
    withPostgresPortalState(local.config, callback, { pool });
  try {
    await run((db) => {
      db.prepare(
        "INSERT INTO users(id,username,discord_id,password_hash,created_at) VALUES(?,?,?,?,?)",
      ).run(
        "personal",
        "personal",
        "990000000000000001",
        "existing-hash",
        "2026-01-01",
      );
      db.prepare(
        "INSERT INTO user_preferences(user_id,wallpaper,updated_at) VALUES(?,?,?)",
      ).run("personal", "amsterdam", "2026-01-01");
    });
    // Simulate the deployed schema before personal themes were introduced.
    const stored = pool.state.meta.sqlite_schema.find(
      (entry) => entry.name === "user_preferences",
    );
    stored.sql = stored.sql.replace(",theme TEXT NOT NULL DEFAULT 'light'", "");
    for (const row of pool.state.rows.user_preferences) delete row.theme;
    const revision = pool.state.meta.revision;
    await run((db) => {
      const preference = db
        .prepare(
          "SELECT wallpaper,theme FROM user_preferences WHERE user_id='personal'",
        )
        .get();
      assert.equal(preference.wallpaper, "amsterdam");
      assert.equal(preference.theme, "light");
      db.prepare(
        "UPDATE user_preferences SET wallpaper='amsterdamrp',theme='dark' WHERE user_id='personal'",
      ).run();
    });
    assert.equal(pool.state.meta.revision, revision);
    assert.ok(
      pool.queries.some((sql) =>
        sql.includes(
          'ALTER TABLE "public"."user_preferences" ADD COLUMN IF NOT EXISTS "theme"',
        ),
      ),
    );
    await run((db) => {
      const preference = db
        .prepare(
          "SELECT wallpaper,theme FROM user_preferences WHERE user_id='personal'",
        )
        .get();
      assert.equal(preference.wallpaper, "amsterdamrp");
      assert.equal(preference.theme, "dark");
    });
  } finally {
    local.close();
  }
});
