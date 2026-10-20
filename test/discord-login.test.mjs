import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes, createHash } from "node:crypto";
import serverless from "serverless-http";
import { createApp } from "../server/app.mjs";
import {
  openDatabase,
  timestamp,
  setAccountAccess,
} from "../server/database.mjs";

async function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gov-discord-login-"));
  const config = {
    dataDir,
    key: randomBytes(32),
    production: false,
    discordReady: true,
    origin: "https://overheid.test",
    guildId: "990000000000000001",
    clientId: "990000000000000002",
    clientSecret: "test-only-secret",
    roles: {
      owner: ["owner-role"],
      admin: [],
      police: ["police-role"],
      command: ["command-role"],
      ambulance: [],
    },
  };
  const db = openDatabase(config);
  const identities = {
    agent: {
      id: "990000000000000010",
      username: "agent",
      roles: config.roles.police,
    },
    command: {
      id: "990000000000000011",
      username: "command",
      roles: config.roles.command,
    },
    owner: {
      id: "990000000000000012",
      username: "owner",
      roles: config.roles.owner,
    },
    manual: { id: "990000000000000013", username: "manual", roles: [] },
    stranger: { id: "990000000000000014", username: "stranger", roles: [] },
    disabled: {
      id: "990000000000000015",
      username: "disabled",
      roles: config.roles.command,
    },
  };
  db.prepare("INSERT INTO users VALUES(?,?,?,?,1,1,?)").run(
    "owner",
    "owner",
    identities.owner.id,
    "unused",
    timestamp(),
  );
  db.prepare("INSERT INTO users VALUES(?,?,?,?,1,1,?)").run(
    "manual",
    "custom",
    identities.manual.id,
    "unused",
    timestamp(),
  );
  setAccountAccess(
    db,
    "manual",
    { profile: "police-agent", permissions: { policeRead: true } },
    "owner",
  );
  db.prepare("INSERT INTO users VALUES(?,?,?,?,0,0,?)").run(
    "disabled",
    "disabled",
    identities.disabled.id,
    "unused",
    timestamp(),
  );
  let exchanges = 0,
    exchangeBody;
  const request = async (url, options) => {
    if (url.endsWith("/oauth2/token")) {
      exchanges++;
      exchangeBody = options.body;
      return Response.json({
        access_token: options.body.get("code"),
        refresh_token: "refresh",
        expires_in: 3600,
      });
    }
    const name = options.headers.Authorization.replace("Bearer ", "");
    const who = identities[name];
    if (!who) return Response.json({}, { status: 401 });
    return url.endsWith("/users/@me")
      ? Response.json({ id: who.id, username: who.username })
      : Response.json({ roles: who.roles });
  };
  const service = await createApp(config, { db, request, serverless: true });
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
        const url = new URL(route, config.origin);
        const result = await handler(
          {
            httpMethod: method,
            path: url.pathname,
            queryStringParameters: Object.fromEntries(url.searchParams),
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
          result.multiValueHeaders?.["Set-Cookie"] ||
          result.headers?.["set-cookie"] ||
          result.headers?.["Set-Cookie"] ||
          result.cookies ||
          [];
        const hs = Array.isArray(set) ? set : [set];
        for (const h of hs) {
          const [k, v] = h.split(";", 1)[0].split("=");
          if (v) cookies.set(k, v);
          else cookies.delete(k);
        }
        const headers = new Headers(result.headers),
          text = result.isBase64Encoded
            ? Buffer.from(result.body, "base64").toString()
            : result.body;
        const data = headers.get("content-type")?.includes("json")
          ? JSON.parse(text)
          : text;
        if (route === "/api/me" && result.statusCode === 200) csrf = data.csrf;
        return { status: result.statusCode, data, headers };
      },
      async start() {
        const response = await this.send("/auth/discord/login", "POST", {});
        assert.equal(response.status, 200);
        return new URL(response.data.oauthUrl);
      },
      async finish(who, authorization) {
        return this.send(
          "/auth/discord/callback?code=" +
            who +
            "&state=" +
            authorization.searchParams.get("state") +
            "&iss=https%3A%2F%2Fdiscord.com",
        );
      },
    };
  }
  return {
    db,
    config,
    identities,
    client,
    exchanges: () => exchanges,
    exchangeBody: () => exchangeBody,
  };
}

test("Rechtstreeks Discord: politie, korpsleiding, eigenaar en handmatige toegang behouden afzonderlijke rechten", async (t) => {
  const f = await fixture(t);
  for (const [name, write, owner] of [
    ["agent", false, false],
    ["command", true, false],
    ["owner", true, true],
    ["manual", false, false],
  ]) {
    const browser = f.client(),
      authorization = await browser.start();
    assert.equal(authorization.origin, "https://discord.com");
    assert.equal(
      authorization.searchParams.get("redirect_uri"),
      f.config.origin + "/auth/discord/callback",
    );
    assert.equal(
      authorization.searchParams.get("code_challenge_method"),
      "S256",
    );
    assert.equal(
      (await browser.finish(name, authorization)).headers.get("location"),
      "/",
    );
    const verifier = f.exchangeBody().get("code_verifier");
    assert.equal(
      createHash("sha256").update(verifier).digest("base64url"),
      authorization.searchParams.get("code_challenge"),
    );
    const me = await browser.send("/api/me");
    assert.equal(me.status, 200);
    assert.equal(me.data.permissions.policeRead, true);
    assert.equal(me.data.permissions.policeWrite, write);
    assert.equal(me.data.permissions.accounts, owner);
    assert.equal(me.data.authMode, "discord");
    assert.equal(me.data.user.mustChange, false);
    if (name === "manual") assert.equal(me.data.user.id, "manual");
    if (name === "owner") {
      const created = await browser.send("/api/accounts", "POST", {
        discordId: "990000000000000019",
      });
      assert.equal(created.status, 201);
      const user = f.db
        .prepare("SELECT * FROM users WHERE id=?")
        .get(created.data.id);
      assert.equal(user.must_change, 0);
      const access = f.db
        .prepare("SELECT permissions FROM account_access WHERE user_id=?")
        .get(user.id);
      assert.equal(JSON.parse(access.permissions).policeRead, true);
    }
  }
  const returning = f.client();
  await returning.finish("agent", await returning.start());
  assert.equal(
    f.db
      .prepare("SELECT COUNT(*) n FROM users WHERE discord_id=?")
      .get(f.identities.agent.id).n,
    1,
  );
  const audit = JSON.stringify(f.db.prepare("SELECT * FROM audit").all());
  assert.ok(
    !audit.includes("test-only-secret") &&
      !audit.includes("accessToken") &&
      !audit.includes("scrypt$"),
  );
});

test("Discord-login weigert onbekenden, uitgeschakelde accounts, ongebonden callbacks, verlopen flows en herhaling", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (
      await f
        .client()
        .send("/auth/discord/login", "POST", {}, "https://evil.test")
    ).status,
    403,
  );
  for (const name of ["stranger", "disabled"]) {
    const browser = f.client(),
      url = await browser.start();
    assert.match(
      (await browser.finish(name, url)).headers.get("location"),
      /^\/login.html\?loginError=/,
    );
    assert.equal((await browser.send("/api/me")).status, 401);
  }
  assert.equal(
    f.db
      .prepare("SELECT id FROM users WHERE discord_id=?")
      .get(f.identities.stranger.id),
    undefined,
  );
  const browser = f.client(),
    url = await browser.start();
  const prior = f.exchanges();
  assert.match(
    (await f.client().finish("agent", url)).headers.get("location"),
    /loginError/,
  );
  assert.equal(f.exchanges(), prior);
  assert.equal(
    (await browser.finish("agent", url)).headers.get("location"),
    "/",
  );
  const exchanged = f.exchanges();
  assert.match(
    (await browser.finish("agent", url)).headers.get("location"),
    /loginError/,
  );
  assert.equal(f.exchanges(), exchanged);
  const expired = f.client(),
    expiredUrl = await expired.start();
  f.db.prepare("UPDATE discord_login_flows SET expires_at=0").run();
  assert.match(
    (await expired.finish("agent", expiredUrl)).headers.get("location"),
    /loginError/,
  );
  assert.equal(f.exchanges(), exchanged);
});
