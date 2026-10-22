import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import serverless from "serverless-http";
import { createApp } from "../server/app.mjs";
import { openDatabase, getSettings, timestamp } from "../server/database.mjs";
import { hashPassword } from "../server/security.mjs";

test("Onderhoud blokkeert bezoekers en medewerkers, behoudt adminherstel en publiceert alleen de reden", async (t) => {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "gov-maintenance-test-"),
  );
  const config = {
    dataDir,
    key: randomBytes(32),
    production: false,
    origin: "https://maintenance.test",
    discordReady: true,
    botToken: "test-only",
    guildId: "990000000000000000",
    roles: {
      owner: ["990000000000000001"],
      admin: ["990000000000000002"],
      police: ["990000000000000003"],
      command: ["990000000000000004"],
      ambulance: [],
    },
  };
  const db = openDatabase(config),
    password = "Local-Maintenance-Test-2026!";
  const hash = await hashPassword(password);
  const identities = {};
  for (const [index, name] of [
    "owner",
    "admin",
    "police",
    "command",
  ].entries()) {
    const discordId = "99000000000000001" + index;
    identities[discordId] = config.roles[name];
    db.prepare("INSERT INTO users VALUES(?,?,?,?,1,0,?)").run(
      name,
      name,
      discordId,
      hash,
      timestamp(),
    );
  }
  const service = await createApp(config, {
    db,
    request: async (url) => {
      const id = url.split("/").at(-1);
      return Response.json({
        user: { id, username: "Testmedewerker" },
        roles: identities[id] || [],
      });
    },
    creatorRequest: async () =>
      Response.json({
        success: true,
        data: {
          discord_user: {
            id: "960090714950225970",
            avatar: "a_0123456789abcdef0123456789abcdef",
          },
          activities: [{ name: "PRIVATE_ACTIVITY" }],
          discord_status: "online",
        },
      }),
  });
  const handler = serverless(service.app);
  t.after(() => {
    service.close();
    const resolved = path.resolve(dataDir);
    if (
      path.dirname(resolved) === path.resolve(os.tmpdir()) &&
      path.basename(resolved).startsWith("gov-maintenance-test-")
    )
      fs.rmSync(resolved, { recursive: true, force: true });
  });
  function client() {
    const cookies = new Map();
    let csrf = "";
    const send = async (route, method = "GET", body, tokenOverride = null) => {
      const url = new URL(route, config.origin);
      const result = await handler(
        {
          httpMethod: method,
          path: url.pathname,
          queryStringParameters: Object.fromEntries(url.searchParams),
          headers: {
            cookie: [...cookies]
              .map(([key, value]) => key + "=" + value)
              .join("; "),
            origin: config.origin,
            "content-type": "application/json",
            "x-csrf-token": tokenOverride ?? csrf,
          },
          body: body ? JSON.stringify(body) : null,
        },
        {},
      );
      const changed =
        result.multiValueHeaders?.["set-cookie"] ||
        result.headers?.["set-cookie"] ||
        [];
      for (const cookie of Array.isArray(changed) ? changed : [changed]) {
        const [key, value] = cookie.split(";", 1)[0].split("=");
        if (value) cookies.set(key, value);
        else cookies.delete(key);
      }
      const text = result.isBase64Encoded
        ? Buffer.from(result.body, "base64").toString()
        : result.body;
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        /* HTML response. */
      }
      if (route === "/api/me" && result.statusCode === 200) csrf = data.csrf;
      return { status: result.statusCode, data, text, headers: result.headers };
    };
    return {
      send,
      async login(name) {
        assert.equal(
          (await send("/auth/login", "POST", { username: name, password }))
            .status,
          200,
        );
        return send("/api/me");
      },
    };
  }
  const guest = client(),
    owner = client(),
    admin = client(),
    police = client(),
    command = client();
  assert.equal((await guest.send("/login.html")).status, 200);
  await owner.login("owner");
  await admin.login("admin");
  await police.login("police");
  await command.login("command");
  const reason = "Geplande update: personeel & opleidingen.\nWe zijn zo terug.";
  assert.equal(
    (await guest.send("/api/maintenance", "PUT", { enabled: true, reason }))
      .status,
    401,
  );
  assert.equal(
    (await police.send("/api/maintenance", "PUT", { enabled: true, reason }))
      .status,
    403,
  );
  assert.equal(
    (await command.send("/api/maintenance", "PUT", { enabled: true, reason }))
      .status,
    403,
  );
  assert.equal(
    (
      await owner.send(
        "/api/maintenance",
        "PUT",
        { enabled: true, reason },
        "invalid",
      )
    ).status,
    403,
  );
  assert.equal(
    (await owner.send("/api/maintenance", "PUT", { enabled: true, reason: "" }))
      .status,
    400,
  );
  assert.equal(
    (await owner.send("/api/maintenance", "PUT", { enabled: true, reason }))
      .status,
    200,
  );
  assert.equal(getSettings(db).maintenance.reason, reason);
  const publicStatus = await guest.send("/api/site-status");
  assert.equal(publicStatus.status, 200);
  assert.deepEqual(Object.keys(publicStatus.data), ["maintenance"]);
  assert.equal(publicStatus.data.maintenance.enabled, true);
  assert.equal(publicStatus.data.maintenance.reason, reason);
  const publicPage = await guest.send("/");
  assert.equal(publicPage.status, 503);
  assert.ok(
    publicPage.text.includes("Tijdelijk in onderhoud") &&
      publicPage.text.includes("data-creator-credit"),
  );
  assert.equal(
    decodeURIComponent(publicPage.headers["x-amrp-maintenance-reason"]),
    reason,
  );
  assert.equal((await guest.send("/login.html")).status, 503);
  assert.equal((await guest.send("/login.html?beheer=1")).status, 200);
  assert.equal((await police.send("/")).status, 503);
  for (const member of [police, command]) {
    for (const url of [
      "/api/me",
      "/api/bootstrap",
      "/api/preferences",
      "/api/search?q=test",
    ]) {
      const response = await member.send(url);
      assert.equal(response.status, 503);
      assert.equal(response.data.code, "SITE_MAINTENANCE");
      assert.equal(response.data.maintenance.reason, reason);
    }
  }
  const newPolice = client();
  assert.equal((await newPolice.login("police")).status, 503);
  assert.equal((await admin.send("/api/me")).data.maintenance.enabled, true);
  assert.equal((await admin.send("/api/bootstrap")).status, 200);
  assert.equal((await admin.send("/")).status, 200);
  const saved = getSettings(db);
  assert.equal(
    (
      await admin.send("/api/settings", "PUT", {
        ...saved,
        name: "Testportaal",
        roles: saved.roles,
        grants: saved.grants,
      })
    ).status,
    200,
  );
  assert.equal(
    getSettings(db).maintenance.enabled,
    true,
    "Normale systeeminstellingen mogen onderhoud niet opheffen",
  );
  const newReason =
    "Update duurt iets langer. De database wordt gecontroleerd.";
  assert.equal(
    (
      await admin.send("/api/maintenance", "PUT", {
        enabled: true,
        reason: newReason,
      })
    ).status,
    200,
  );
  assert.equal(
    (await guest.send("/api/site-status")).data.maintenance.reason,
    newReason,
  );
  const creator = await guest.send("/api/creator");
  assert.equal(creator.status, 200);
  assert.deepEqual(Object.keys(creator.data).sort(), [
    "avatarUrl",
    "discordId",
  ]);
  assert.ok(creator.data.avatarUrl.includes(".gif?size=64"));
  assert.ok(
    !creator.text.includes("PRIVATE_ACTIVITY") &&
      !creator.text.includes("online"),
  );
  assert.equal(
    (
      await admin.send("/api/maintenance", "PUT", {
        enabled: false,
        reason: "",
      })
    ).status,
    200,
  );
  assert.equal(
    (await guest.send("/api/site-status")).data.maintenance.enabled,
    false,
  );
  assert.equal((await police.send("/api/me")).status, 200);
  assert.equal((await command.send("/api/bootstrap")).status, 200);
  assert.equal((await guest.send("/login.html")).status, 200);
  assert.ok(
    db
      .prepare(
        "SELECT COUNT(*) n FROM audit WHERE action='systeem.onderhoud_ingeschakeld'",
      )
      .get().n >= 1,
  );
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) n FROM audit WHERE action='systeem.onderhoud_beeindigd'",
      )
      .get().n,
    1,
  );
});
