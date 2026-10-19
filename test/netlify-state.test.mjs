import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { withNetlifyPortalState } from "../server/netlify-state.mjs";

function createPool() {
  let image = null;
  return {
    async query() {
      return { rows: [] };
    },
    async connect() {
      let pendingImage = null;
      return {
        async query(sql, values = []) {
          if (sql === "BEGIN") return { rows: [] };
          if (sql === "COMMIT") {
            if (pendingImage) image = pendingImage;
            return { rows: [] };
          }
          if (sql === "ROLLBACK") {
            pendingImage = null;
            return { rows: [] };
          }
          if (sql.includes("SELECT pg_advisory_xact_lock")) return { rows: [] };
          if (sql.includes("SELECT sqlite_image"))
            return { rows: image ? [{ sqlite_image: image }] : [] };
          if (sql.includes("INSERT INTO amrp_portal_state")) {
            pendingImage = Buffer.from(values[0]);
            return { rows: [] };
          }
          throw new Error(`Unexpected query: ${sql}`);
        },
        release() {},
      };
    },
  };
}

test("Netlify database snapshot persists across calls and rolls back failures", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "amrp-state-test-"));
  const config = {
    dataDir: root,
    roles: {
      owner: [],
      admin: [],
      police: [],
      command: [],
      ambulance: [],
    },
  };
  const pool = createPool();
  try {
    const initial = await withNetlifyPortalState(
      config,
      (db) => db.prepare("SELECT value FROM settings WHERE id=1").get().value,
      { pool },
    );
    const replacement = JSON.stringify({ name: "Amsterdam test" });
    await withNetlifyPortalState(
      config,
      (db) =>
        db.prepare("UPDATE settings SET value=? WHERE id=1").run(replacement),
      { pool },
    );

    const restored = await withNetlifyPortalState(
      config,
      (db) => db.prepare("SELECT value FROM settings WHERE id=1").get().value,
      { pool },
    );
    assert.equal(restored, replacement);
    assert.notEqual(restored, initial);

    await assert.rejects(
      withNetlifyPortalState(
        config,
        (db) => {
          db.prepare("UPDATE settings SET value=? WHERE id=1").run(
            "discard me",
          );
          throw new Error("simulated request failure");
        },
        { pool },
      ),
      /simulated request failure/,
    );

    const afterFailure = await withNetlifyPortalState(
      config,
      (db) => db.prepare("SELECT value FROM settings WHERE id=1").get().value,
      { pool },
    );
    assert.equal(afterFailure, replacement);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
