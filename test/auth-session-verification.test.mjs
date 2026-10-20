import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import serverless from "serverless-http";
import { createApp } from "../server/app.mjs";
import { openDatabase, timestamp } from "../server/database.mjs";
import { encrypt, decrypt, digest } from "../server/security.mjs";

async function fixture(t, { expired = false } = {}) {
  let now = Date.UTC(2026, 9, 20, 15),
    refreshes = 0,
    checks = 0,
    fail = false,
    revoked = false;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gov-auth-cache-"));
  const config = {
    dataDir,
    key: randomBytes(32),
    production: false,
    demo: false,
    discordReady: true,
    origin: "https://auth.test",
    guildId: "990000000000000001",
    clientId: "client",
    clientSecret: "fixture-secret",
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
    timestamp(),
  );
  const raw = "test-verified-session",
    hash = digest(raw);
  db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?,?)").run(
    hash,
    "staff",
    "csrf",
    encrypt(
      {
        accessToken: "access-old",
        refreshToken: "refresh-old",
        expiresAt: now + (expired ? 0 : 3600000),
      },
      config.key,
    ),
    now + 28800000,
    now,
  );
  t.after(() => {
    db.close();
    assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir()));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const request = async (url, options) => {
    if (url.endsWith("/oauth2/token")) {
      refreshes++;
      assert.equal(options.body.get("refresh_token"), "refresh-old");
      // Token rotation is single-use; parallel callers must join one exchange.
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (refreshes > 1)
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      return Response.json({
        access_token: "access-new",
        refresh_token: "refresh-new",
        expires_in: 3600,
      });
    }
    checks++;
    if (url.endsWith("/users/@me"))
      return Response.json({ id: "990000000000000003", username: "staff" });
    assert.ok(url.endsWith("/member"));
    return fail
      ? Response.json({ message: "temporary" }, { status: 503 })
      : Response.json({ roles: revoked ? [] : config.roles.police });
  };
  async function instance() {
    const service = await createApp(config, {
      db,
      request,
      clock: () => now,
      serverless: true,
    });
    const handler = serverless(service.app);
    return async () => {
      const result = await handler(
        {
          httpMethod: "GET",
          path: "/api/me",
          headers: { cookie: "gov-session=" + raw },
          body: null,
        },
        {},
      );
      return { status: result.statusCode, data: JSON.parse(result.body) };
    };
  }
  return {
    instance,
    readTokens: () =>
      decrypt(
        db.prepare("SELECT tokens FROM sessions WHERE hash=?").get(hash).tokens,
        config.key,
      ),
    advance: (ms) => (now += ms),
    counts: () => ({ refreshes, checks }),
    outage: (value) => (fail = value),
    revoke: () => (revoked = true),
  };
}

test("Rechtencontrole blijft maximaal 30 seconden gedeeld tussen serverless instanties", async (t) => {
  const f = await fixture(t),
    first = await f.instance();
  assert.equal((await first()).status, 200);
  assert.deepEqual(f.counts(), { refreshes: 0, checks: 2 });
  for (let n = 0; n < 4; n++)
    assert.equal((await (await f.instance())()).status, 200);
  assert.equal(
    f.counts().checks,
    2,
    "Nieuwe instanties hergebruiken alleen de recent geverifieerde encrypted sessie",
  );
  f.advance(30001);
  f.revoke();
  assert.equal(
    (await (await f.instance())()).status,
    403,
    "Ingetrokken rollen worden na de korte cache geweigerd",
  );
  assert.equal(f.counts().checks, 4);
});

test("Gelijktijdige acties gebruiken één refresh en bewaren het geroteerde Discord-token", async (t) => {
  const f = await fixture(t, { expired: true }),
    request = await f.instance();
  const results = await Promise.all([request(), request(), request()]);
  assert.deepEqual(
    results.map((x) => x.status),
    [200, 200, 200],
  );
  assert.equal(f.counts().refreshes, 1);
  assert.equal(f.counts().checks, 2);
  assert.equal(f.readTokens().refreshToken, "refresh-new");
  assert.equal((await (await f.instance())()).status, 200);
  assert.equal(f.counts().refreshes, 1);
});

test("Een mislukte rechtencontrole verliest geen vernieuwd token en gebruikt geen verlopen rechten", async (t) => {
  const f = await fixture(t, { expired: true }),
    request = await f.instance();
  f.outage(true);
  assert.equal((await request()).status, 503);
  assert.equal(f.readTokens().refreshToken, "refresh-new");
  assert.equal(f.readTokens().verification, undefined);
  f.outage(false);
  assert.equal((await (await f.instance())()).status, 200);
  assert.equal(f.counts().refreshes, 1);
  f.advance(30001);
  f.outage(true);
  assert.equal(
    (await (await f.instance())()).status,
    503,
    "Na het verlopen van de controle worden eerdere rechten niet alsnog toegelaten",
  );
});
