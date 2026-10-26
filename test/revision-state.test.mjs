import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { openDatabase } from "../server/database.mjs";
import { digest, encrypt } from "../server/security.mjs";
import { readAuthenticatedRevision } from "../server/revision-state.mjs";

function fixture(t) {
  const now = Date.now(),
    raw = "fixture-session",
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gov-revision-"));
  const config = {
    dataDir,
    key: randomBytes(32),
    production: false,
    guildId: "990000000000000001",
    roles: {
      owner: [],
      admin: [],
      police: ["990000000000000002"],
      command: [],
      ambulance: [],
    },
  };
  const db = openDatabase(config);
  db.prepare("INSERT INTO users VALUES(?,?,?,?,1,0,?)").run(
    "staff",
    "staff",
    "990000000000000003",
    "unused",
    new Date(now).toISOString(),
  );
  const credentials = {
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt: now + 3600000,
    verification: {
      key: digest("access"),
      guildId: config.guildId,
      expiresAt: now + 30000,
      value: {
        identity: { id: "990000000000000003", username: "staff" },
        roles: config.roles.police,
      },
    },
  };
  db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?,?)").run(
    digest(raw),
    "staff",
    "csrf",
    encrypt(credentials, config.key),
    now + 28800000,
    now,
  );
  const row = {
    revision: 42,
    sqlite_schema: db
      .prepare("SELECT type,name,sql FROM sqlite_master WHERE type='table'")
      .all(),
    settings: db.prepare("SELECT * FROM settings WHERE id=1").get(),
    account: db.prepare("SELECT * FROM users WHERE id='staff'").get(),
    session: db.prepare("SELECT * FROM sessions").get(),
    access: null,
  };
  db.close();
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const queries = [];
  const pool = {
    async connect() {
      return {
        async query(sql, values = []) {
          queries.push(sql);
          if (sql.includes("/* amrp:revision */"))
            return { rows: [structuredClone(row)] };
          if (sql.startsWith("UPDATE public.sessions")) {
            row.session.tokens = values[1];
            row.session.last_seen = values[2];
          }
          if (sql.startsWith("DELETE FROM public.sessions")) row.session = null;
          assert.ok(
            ["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) ||
              /^(SELECT pg_advisory|UPDATE public.sessions|DELETE FROM public.sessions)/.test(
                sql,
              ),
            sql,
          );
          return { rows: [] };
        },
        release() {},
      };
    },
  };
  const request = new Request("https://portal.test/api/changes", {
    headers: { cookie: "gov-session=" + raw },
  });
  return { row, config, pool, request, queries, now };
}

test("revision polling uses scoped rows, shared auth and no writes for a recently verified session", async (t) => {
  const f = fixture(t);
  const response = await readAuthenticatedRevision(
    f.pool,
    f.config,
    f.request,
    {
      clock: () => f.now,
      request() {
        assert.fail("A fresh verification needs no extra Discord request");
      },
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { revision: "42" });
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(
    f.queries.filter((sql) => sql.includes("/* amrp:revision */")).length,
    1,
  );
  assert.equal(
    f.queries.filter((sql) => /^(UPDATE|DELETE|INSERT)/.test(sql)).length,
    0,
  );
});

test("disabled accounts and expired sessions remain blocked", async (t) => {
  for (const invalid of ["disabled", "expired"]) {
    const f = fixture(t);
    if (invalid === "disabled") f.row.account.enabled = 0;
    else f.row.session.expires_at = f.now - 1;
    const response = await readAuthenticatedRevision(
      f.pool,
      f.config,
      f.request,
      { clock: () => f.now },
    );
    assert.equal(response.status, 401);
    assert.equal(f.queries.at(-1), "COMMIT");
  }
});

test("identity polling retains the private session response and password-change flow", async (t) => {
  const f = fixture(t);
  f.row.account.must_change = 1;
  const request = new Request("https://portal.test/api/me", {
    headers: f.request.headers,
  });
  const response = await readAuthenticatedRevision(f.pool, f.config, request, {
    clock: () => f.now,
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const payload = await response.json();
  assert.equal(payload.user.username, "staff");
  assert.equal(payload.user.mustChange, true);
  assert.equal(payload.permissions.policeRead, true);
  assert.equal(payload.csrf, "csrf");
  assert.equal("tokens" in payload, false);
  assert.equal("password_hash" in payload.user, false);
  assert.equal(
    (
      await readAuthenticatedRevision(f.pool, f.config, f.request, {
        clock: () => f.now,
      })
    ).status,
    403,
  );
});

test("role revocations are checked through Discord and block access", async (t) => {
  const f = fixture(t);
  const response = await readAuthenticatedRevision(
    f.pool,
    f.config,
    f.request,
    {
      clock: () => f.now + 30001,
      request: async (url) =>
        url.endsWith("/users/@me")
          ? Response.json({ id: f.row.account.discord_id })
          : Response.json({ roles: [] }),
    },
  );
  assert.equal(response.status, 403);
});

test("maintenance blocks non-admins and missing migrations keep the full safe fallback", async (t) => {
  const f = fixture(t);
  const settings = JSON.parse(f.row.settings.value);
  f.row.settings.value = JSON.stringify({
    ...settings,
    maintenance: { enabled: true, reason: "Testonderhoud" },
  });
  const response = await readAuthenticatedRevision(
    f.pool,
    f.config,
    f.request,
    { clock: () => f.now },
  );
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "60");
  assert.equal(response.headers.get("x-amrp-maintenance"), "1");
  assert.equal((await response.json()).code, "SITE_MAINTENANCE");
  f.row.sqlite_schema = [];
  assert.equal(
    await readAuthenticatedRevision(f.pool, f.config, f.request),
    null,
  );
  assert.equal(f.queries.at(-1), "ROLLBACK");
});
