import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import serverless from "serverless-http";
import { createApp } from "../server/app.mjs";
import { openDatabase, timestamp } from "../server/database.mjs";
import { bridgeRequest } from "../server/netlify-function-adapter.mjs";
import { hashPassword } from "../server/security.mjs";

const origin = "https://login-tests.example";
const password = "Login-Regression-Password-2026!";
const passwordHash = await hashPassword(password);
const firstIp = "192.0.2.10";
const secondIp = "192.0.2.11";
const username = "medewerker";

async function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gov-login-limit-"));
  let now = Date.UTC(2026, 9, 20, 12);
  const config = {
    dataDir,
    key: randomBytes(32),
    production: false,
    demo: true,
    discordReady: true,
    origin,
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
    "test-user",
    username,
    "990000000000000003",
    passwordHash,
    timestamp(),
  );
  const service = await createApp(config, {
    db,
    serverless: true,
    clock: () => now,
    discord: {
      async member(tokens) {
        return {
          identity: { id: tokens.demoId, username },
          roles: config.roles.police,
          tokens,
        };
      },
    },
  });
  t.after(() => {
    service.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const proxy = serverless(service.app, { binary: true });
  return {
    db,
    advance(ms) {
      now += ms;
    },
    seedLegacy() {
      for (const [key, count] of [
        ["login-user:" + username, 10],
        ["login-ip:" + firstIp, 20],
      ])
        db.prepare("INSERT OR REPLACE INTO rate_limits VALUES(?,?,?)").run(
          key,
          count,
          now + 15 * 60_000,
        );
    },
    failure(ip = firstIp) {
      return db
        .prepare("SELECT * FROM rate_limits WHERE key=?")
        .get(`login-failures-v2:${ip}:${username}`);
    },
    async login({ ip = firstIp, suppliedPassword = password } = {}) {
      const response = await bridgeRequest(
        new Request(origin + "/auth/login", {
          method: "POST",
          headers: {
            origin,
            "content-type": "application/json",
            "x-forwarded-for": ip,
          },
          body: JSON.stringify({ username, password: suppliedPassword }),
        }),
        { ip },
        proxy,
      );
      return {
        status: response.status,
        headers: response.headers,
        data: await response.json(),
      };
    },
  };
}

async function exhaustFailures(client, ip = firstIp) {
  for (let attempt = 0; attempt < 10; attempt++)
    assert.equal(
      (await client.login({ ip, suppliedPassword: "verkeerd" })).status,
      401,
    );
  return client.login({ ip, suppliedPassword: "verkeerd" });
}

test("correcte herhaalde aanmeldingen verbruiken geen foutquotum", async (t) => {
  const client = await fixture(t);
  for (let attempt = 0; attempt < 15; attempt++)
    assert.equal((await client.login()).status, 200);
  assert.equal(client.failure(), undefined);
});

test("oude blokkades tellen niet mee en verdwijnen na een correct wachtwoord", async (t) => {
  const client = await fixture(t);
  client.seedLegacy();
  assert.equal(
    (await client.login({ suppliedPassword: "verkeerd" })).status,
    401,
  );
  assert.equal((await client.login()).status, 200);
  for (const key of ["login-user:" + username, "login-ip:" + firstIp])
    assert.equal(
      client.db.prepare("SELECT * FROM rate_limits WHERE key=?").get(key),
      undefined,
    );
  assert.equal(client.failure(), undefined);
});

test("de elfde foute aanmelding krijgt een wachttijd van maximaal een minuut", async (t) => {
  const client = await fixture(t);
  const blocked = await exhaustFailures(client);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get("retry-after"), "60");
  assert.doesNotMatch(blocked.data.error, /15 minuten/);
  assert.equal(client.failure().count, 10);
});

test("een correct wachtwoord werkt direct na de foutlimiet en herstelt het quotum", async (t) => {
  const client = await fixture(t);
  assert.equal((await exhaustFailures(client)).status, 429);
  assert.equal((await client.login()).status, 200);
  assert.equal(client.failure(), undefined);
  assert.equal(
    (await client.login({ suppliedPassword: "verkeerd" })).status,
    401,
  );
  assert.equal(client.failure().count, 1);
});

test("verschillende IP-adressen delen geen gebruikersnaamblokkade", async (t) => {
  const client = await fixture(t);
  assert.equal((await exhaustFailures(client)).status, 429);
  assert.equal(
    (
      await client.login({
        ip: secondIp,
        suppliedPassword: "verkeerd",
      })
    ).status,
    401,
  );
  assert.equal(client.failure(secondIp).count, 1);
  assert.equal((await client.login({ ip: secondIp })).status, 200);
  assert.equal(client.failure(secondIp), undefined);
  assert.equal(
    (await client.login({ suppliedPassword: "verkeerd" })).status,
    429,
  );
});

test("de resterende wachttijd loopt af en foute pogingen werken weer na een minuut", async (t) => {
  const client = await fixture(t);
  assert.equal((await exhaustFailures(client)).status, 429);
  client.advance(30_000);
  const waiting = await client.login({ suppliedPassword: "verkeerd" });
  assert.equal(waiting.status, 429);
  assert.equal(waiting.headers.get("retry-after"), "30");
  client.advance(30_001);
  assert.equal(
    (await client.login({ suppliedPassword: "verkeerd" })).status,
    401,
  );
  assert.equal(client.failure().count, 1);
});
