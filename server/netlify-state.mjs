import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "./database.mjs";

const STATE_TABLE = "amrp_portal_state";
const LOCK_ID = 731904211;
const readyPools = new WeakMap();
let defaultPool;

async function preparePool(pool) {
  let ready = readyPools.get(pool);
  if (!ready) {
    ready = pool.query(`
      CREATE TABLE IF NOT EXISTS ${STATE_TABLE} (
        id SMALLINT PRIMARY KEY CHECK (id = 1),
        sqlite_image BYTEA NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    readyPools.set(pool, ready);
  }
  await ready;
}

export async function withNetlifyPortalState(config, callback, { pool } = {}) {
  if (!pool) {
    if (!defaultPool) {
      const { getDatabase } = await import("@netlify/database");
      defaultPool = getDatabase().pool;
    }
    pool = defaultPool;
  }
  await preparePool(pool);
  const client = await pool.connect();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "amrp-portal-"));
  let db;
  let transactionOpen = false;
  let result;
  try {
    await client.query("BEGIN");
    transactionOpen = true;
    // The app's synchronous SQLite transactions are kept intact. This lock
    // makes each Netlify request load and save one authoritative DB snapshot.
    await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [LOCK_ID]);
    const saved = await client.query(
      `SELECT sqlite_image FROM ${STATE_TABLE} WHERE id = 1`,
    );
    const file = path.join(dataDir, "portal.sqlite");
    if (saved.rows[0]?.sqlite_image)
      fs.writeFileSync(file, saved.rows[0].sqlite_image, { mode: 0o600 });
    db = openDatabase({ ...config, dataDir });
    result = await callback(db);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
    db = null;
    const image = fs.readFileSync(file);
    await client.query(
      `INSERT INTO ${STATE_TABLE}(id, sqlite_image, updated_at)
       VALUES (1, $1, NOW())
       ON CONFLICT (id) DO UPDATE
       SET sqlite_image = EXCLUDED.sqlite_image, updated_at = NOW()`,
      [image],
    );
    await client.query("COMMIT");
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    if (db) db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    client.release();
  }
  return result;
}

export function netlifyArchiveFiles(store) {
  return {
    async put(name, buffer) {
      await store.set(name, new Blob([buffer]), {
        metadata: { uploadedAt: new Date().toISOString() },
      });
    },
    async get(name) {
      const value = await store.get(name, {
        consistency: "strong",
        type: "arrayBuffer",
      });
      return value === null ? null : Buffer.from(value);
    },
    async delete(name) {
      await store.delete(name);
    },
  };
}
