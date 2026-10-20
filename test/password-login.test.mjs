import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import serverless from "serverless-http";
import { createApp } from "../server/app.mjs";
import {
  openDatabase,
  timestamp,
  setAccountAccess,
} from "../server/database.mjs";
import { hashPassword, decrypt } from "../server/security.mjs";

const password = "Gewoon-Inloggen-2026!";
const passwordHash = await hashPassword(password);
async function fixture(t) {
  let now = Date.UTC(2026, 9, 20),
    unavailable = false;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gov-password-"));
  const config = {
    dataDir,
    key: randomBytes(32),
    origin: "https://password.test",
    production: false,
    demo: false,
    discordReady: true,
    botToken: "test-bot-secret",
    guildId: "990000000000000001",
    roles: {
      owner: ["owner-role"],
      admin: [],
      police: ["police-role"],
      command: ["command-role"],
      ambulance: [],
    },
  };
  const db = openDatabase(config),
    calls = [],
    memberships = {
      "990000000000000010": ["owner-role"],
      "990000000000000011": ["command-role"],
    };
  for (const [name, id] of [
    ["owner", "990000000000000010"],
    ["command", "990000000000000011"],
  ])
    db.prepare("INSERT INTO users VALUES(?,?,?,?,1,0,?)").run(
      name,
      name,
      id,
      passwordHash,
      timestamp(),
    );
  const service = await createApp(config, {
    db,
    serverless: true,
    clock: () => now,
    request: async (url, options) => {
      calls.push(url);
      assert.ok(url.includes("/guilds/" + config.guildId + "/members/"));
      assert.equal(options.headers.Authorization, "Bot test-bot-secret");
      if (unavailable)
        return Response.json({ error: "temporary" }, { status: 503 });
      const id = url.split("/").at(-1);
      return Response.json({
        user: { id, username: "discord-name" },
        roles: memberships[id] || [],
      });
    },
  });
  const handler = serverless(service.app);
  t.after(() => {
    service.close();
    assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir()));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  function client() {
    const cookies = new Map();
    let csrf = "";
    return {
      async send(route, method = "GET", body, origin = config.origin) {
        const result = await handler(
          {
            httpMethod: method,
            path: route,
            headers: {
              cookie: [...cookies].map(([k, v]) => k + "=" + v).join("; "),
              origin,
              "content-type": "application/json",
              "x-csrf-token": csrf,
            },
            body: body ? JSON.stringify(body) : null,
          },
          {},
        );
        const set =
          result.multiValueHeaders?.["set-cookie"] ||
          result.headers?.["set-cookie"] ||
          [];
        for (const item of Array.isArray(set) ? set : [set]) {
          const [name, value] = item.split(";", 1)[0].split("=");
          if (value) cookies.set(name, value);
          else cookies.delete(name);
        }
        const text = result.isBase64Encoded
          ? Buffer.from(result.body, "base64").toString()
          : result.body;
        const data = JSON.parse(text);
        if (route === "/api/me" && result.statusCode === 200) csrf = data.csrf;
        return { status: result.statusCode, data };
      },
      login(username, supplied = password) {
        return this.send("/auth/login", "POST", {
          username,
          password: supplied,
        });
      },
    };
  }
  return {
    db,
    key: config.key,
    client,
    calls,
    memberships,
    advance: (ms) => (now += ms),
    outage: (value) => (unavailable = value),
  };
}

test("Een eigenaar maakt gebruikersnaam, Discord-ID en wachtwoord aan: direct aanmelden zonder OAuth of verplichte reset", async (t) => {
  const f = await fixture(t),
    owner = f.client();
  const login = await owner.login("owner");
  assert.equal(login.status, 200);
  assert.deepEqual(login.data, { ok: true });
  const ownMe = await owner.send("/api/me");
  assert.equal(ownMe.data.permissions.owner, true);
  assert.equal(ownMe.data.authMode, "password");
  const created = await owner.send("/api/accounts", "POST", {
    username: "medewerker",
    discordId: "990000000000000012",
    password,
  });
  assert.equal(created.status, 201);
  const person = f.client();
  assert.deepEqual((await person.login("medewerker")).data, { ok: true });
  const me = await person.send("/api/me");
  assert.equal(me.data.user.mustChange, false);
  assert.equal(me.data.permissions.policeRead, true);
  assert.equal(me.data.permissions.accounts, false);
  assert.equal(me.data.permissions.owner, false);
  assert.equal((await person.send("/api/bootstrap")).status, 200);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM auth_flows").get().n, 0);
  for (const row of f.db.prepare("SELECT tokens FROM sessions").all()) {
    const tokens = decrypt(row.tokens, f.key);
    assert.equal(tokens.method, "password");
    assert.ok(!JSON.stringify(tokens).includes(password));
  }
  const changedPassword = "Nieuw-Inloggen-2026!";
  assert.equal(
    (
      await owner.send("/api/accounts/" + created.data.id, "PUT", {
        username: "nieuwenaam",
        discordId: "990000000000000012",
        password: changedPassword,
      })
    ).status,
    200,
  );
  assert.equal((await person.send("/api/me")).status, 401);
  assert.equal((await f.client().login("medewerker")).status, 401);
  const changed = f.client();
  assert.equal(
    (await changed.login("nieuwenaam", changedPassword)).status,
    200,
  );
  assert.equal((await changed.send("/api/me")).data.user.mustChange, false);
  assert.equal(
    (
      await owner.send("/api/accounts/" + created.data.id, "PUT", {
        enabled: false,
      })
    ).status,
    200,
  );
  assert.equal((await changed.send("/api/me")).status, 401);
  assert.equal(
    (await f.client().login("nieuwenaam", changedPassword)).status,
    401,
  );
  const audit = JSON.stringify(f.db.prepare("SELECT * FROM audit").all());
  assert.ok(
    !audit.includes(password) &&
      !audit.includes(changedPassword) &&
      !audit.includes("scrypt$"),
  );
});

test("Wachtwoordsessies verliezen ingetrokken dienstrollen; lokale accountrechten werken bij een Discord-storing", async (t) => {
  const f = await fixture(t),
    command = f.client();
  assert.equal((await command.login("command")).status, 200);
  assert.equal(
    (await command.send("/api/me")).data.permissions.policeWrite,
    true,
  );
  f.memberships["990000000000000011"] = [];
  f.advance(31000);
  assert.equal((await command.send("/api/bootstrap")).status, 403);
  f.db
    .prepare("INSERT INTO users VALUES(?,?,?,?,1,0,?)")
    .run("local", "local", "990000000000000013", passwordHash, timestamp());
  setAccountAccess(
    f.db,
    "local",
    { profile: "archive", permissions: { archive: true } },
    "owner",
  );
  f.outage(true);
  const local = f.client();
  assert.equal((await local.login("local")).status, 200);
  const me = await local.send("/api/me");
  assert.equal(me.status, 200);
  assert.equal(me.data.permissions.archive, true);
  assert.equal(me.data.permissions.owner, false);
  assert.equal(me.data.permissions.accounts, false);
  assert.equal((await f.client().login("owner")).status, 503);
  assert.equal((await f.client().login("local", "onjuist")).status, 401);
  assert.equal(
    (
      await f
        .client()
        .send(
          "/auth/login",
          "POST",
          { username: "local", password },
          "https://evil.test",
        )
    ).status,
    403,
  );
});
