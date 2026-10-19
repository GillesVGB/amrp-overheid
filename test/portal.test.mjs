import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createApp } from "../server/app.mjs";
import {
  openDatabase,
  getSettings,
  id,
  timestamp,
} from "../server/database.mjs";
import {
  hashPassword,
  encrypt,
  decrypt,
  permissions,
} from "../server/security.mjs";
test("Volledige werkplek: login, rollen, opslag, archief en accountbeheer", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gov-test-"));
  const config = {
    dataDir,
    key: randomBytes(32),
    production: false,
    demo: true,
    discordReady: true,
    origin: "",
    guildId: "1402056739985162394",
    roles: {
      owner: ["1519394039361835239", "1519394037423931392"],
      admin: ["1519394041165516911"],
      police: ["1519394082277953679"],
      command: ["1519394051760066660"],
      ambulance: [],
    },
  };
  const db = openDatabase(config),
    members = {
      admin: config.roles.admin,
      command: config.roles.command,
      agent: config.roles.police,
      owner: [config.roles.owner[0]],
    };
  const password = "Correct-TestPassword-2026!";
  for (const [index, name] of ["admin", "command", "agent", "owner"].entries())
    db.prepare("INSERT INTO users VALUES(?,?,?,?,1,0,?)").run(
      name,
      name,
      "99000000000000000" + index,
      await hashPassword(password),
      timestamp(),
    );
  const discord = {
    async member(tokens) {
      const name = tokens.demoId.endsWith("0")
        ? "admin"
        : tokens.demoId.endsWith("1")
          ? "command"
          : tokens.demoId.endsWith("2")
            ? "agent"
            : "owner";
      return {
        identity: { id: tokens.demoId, username: name },
        roles: members[name],
        tokens,
      };
    },
  };
  const service = await createApp(config, { db, discord }),
    server = service.app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = "http://127.0.0.1:" + server.address().port;
  config.origin = base;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    service.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  function client() {
    let cookie = "",
      csrf = "";
    return {
      async request(
        route,
        { method = "GET", body, origin = base, token = csrf } = {},
      ) {
        const form = body instanceof FormData;
        const r = await fetch(base + route, {
          method,
          redirect: "manual",
          headers: {
            ...(cookie ? { Cookie: cookie } : {}),
            ...(method !== "GET"
              ? { Origin: origin, "X-CSRF-Token": token }
              : {}),
            ...(body && !form ? { "Content-Type": "application/json" } : {}),
          },
          body: form ? body : body ? JSON.stringify(body) : undefined,
        });
        const set = r.headers.getSetCookie();
        if (set.length) cookie = set.map((x) => x.split(";")[0]).join("; ");
        let data;
        const content = r.headers.get("content-type") || "";
        if (content.includes("json")) data = await r.json();
        else data = await r.text();
        if (route === "/api/me" && r.ok) csrf = data.csrf;
        return { status: r.status, data, headers: r.headers };
      },
      async login(username, pw = password) {
        const result = await this.request("/auth/login", {
          method: "POST",
          body: { username, password: pw },
        });
        if (result.status === 200) await this.request("/api/me");
        return result;
      },
    };
  }
  const anon = client(),
    agent = client(),
    command = client(),
    admin = client(),
    owner = client();
  await t.test("Authenticatie en sessies zijn verplicht", async () => {
    assert.equal((await anon.request("/api/bootstrap")).status, 401);
    assert.equal((await agent.login("agent", "verkeerd")).status, 401);
    assert.equal((await agent.login("agent")).status, 200);
    assert.equal((await command.login("command")).status, 200);
    assert.equal((await admin.login("admin")).status, 200);
    assert.equal((await owner.login("owner")).status, 200);
    const raw = db.prepare("SELECT tokens FROM sessions LIMIT 1").get().tokens;
    assert.ok(!raw.includes("demoId"));
    assert.ok(decrypt(raw, config.key).demoId);
  });
  await t.test("Eigenaar beheert de ambulancemeldingen", async () => {
    const session = await owner.request("/api/me");
    assert.equal(session.data.permissions.owner, true);
    assert.equal(session.data.permissions.settings, true);
    assert.equal(session.data.permissions.ambulance, true);
    assert.equal((await agent.request("/api/ambulance/calls")).status, 403);
    const created = await owner.request("/api/ambulance/calls", {
      method: "POST",
      body: {
        priority: "Spoed",
        location: "Damrak",
        summary: "Fictieve roleplaymelding",
        unit: "Ambulance 12-301",
      },
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.status, "Nieuw");
    const updated = await owner.request(
      "/api/ambulance/calls/" + created.data.id,
      {
        method: "PUT",
        body: {
          priority: "Spoed",
          status: "Onderweg",
          location: "Damrak",
          summary: "Fictieve roleplaymelding",
          unit: "Ambulance 12-301",
        },
      },
    );
    assert.equal(updated.data.status, "Onderweg");
    assert.equal(
      (await owner.request("/api/ambulance/calls")).data.calls.length,
      1,
    );
  });
  let data = (await admin.request("/api/bootstrap")).data;
  const rank = data.ranks.find((x) => x.code === "09"),
    slot = data.callsigns.find((x) => x.rank_id === rank.id);
  await t.test("Speciale reeksen hebben afzonderlijke capaciteit", () => {
    for (const r of data.ranks)
      assert.equal(r.capacity, Number(r.code) <= 5 ? 1 : 30);
  });
  await t.test(
    "Agenten hebben echte leesrechten, zonder mutaties",
    async () => {
      const a = (await agent.request("/api/bootstrap")).data;
      assert.equal(a.accounts.length, 0);
      assert.equal(a.archive.length, 0);
      for (const route of [
        "/api/personnel",
        "/api/callsigns",
        "/api/ranks",
        "/api/categories",
        "/api/archive",
        "/api/accounts",
      ])
        assert.equal(
          (await agent.request(route, { method: "POST", body: {} })).status,
          403,
          route,
        );
      assert.equal(
        (await agent.request("/api/settings", { method: "PUT", body: {} }))
          .status,
        403,
      );
      assert.equal((await agent.request("/api/callsigns.csv")).status, 403);
    },
  );
  await t.test("Korpsleiding kan geen accounts of rollen beheren", async () => {
    assert.equal(
      (await command.request("/api/accounts", { method: "POST", body: {} }))
        .status,
      403,
    );
    assert.equal(
      (await command.request("/api/settings", { method: "PUT", body: {} }))
        .status,
      403,
    );
  });
  let personId;
  await t.test("Personeel, toewijzingen en dubbele nummers", async () => {
    const body = {
      discordId: "980000000000000001",
      discordName: "Test Agent",
      rankId: rank.id,
      active: true,
      callsignId: slot.id,
      place: "Centrum",
    };
    const created = await command.request("/api/personnel", {
      method: "POST",
      body,
    });
    assert.equal(created.status, 201);
    personId = created.data.id;
    assert.equal(
      (
        await command.request("/api/personnel", {
          method: "POST",
          body: { ...body, discordId: "980000000000000002" },
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await command.request("/api/callsigns", {
          method: "POST",
          body: { rankId: rank.id, number: slot.number },
        })
      ).status,
      409,
    );
    const next = data.callsigns.find(
      (x) => x.rank_id === rank.id && x.id !== slot.id,
    );
    assert.equal(
      (
        await command.request("/api/callsigns/" + next.id, {
          method: "PUT",
          body: { number: next.number, personnelId: personId, place: "Zuid" },
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await command.request("/api/personnel/" + personId, {
          method: "PUT",
          body: { ...body, rankId: data.ranks[0].id },
        })
      ).status,
      400,
    );
    assert.equal(
      (await agent.request("/api/bootstrap")).data.personnel[0].discord_name,
      "Test Agent",
    );
  });
  await t.test("Rang verkleinen beschermt toegewezen regels", async () => {
    assert.equal(
      (
        await command.request("/api/ranks/" + rank.id, {
          method: "PUT",
          body: { label: rank.label, capacity: 0 },
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await command.request("/api/ranks/" + data.ranks[0].id, {
          method: "PUT",
          body: { label: "Korpschef", capacity: 3 },
        })
      ).status,
      200,
    );
    assert.equal(
      (await command.request("/api/bootstrap")).data.callsigns.filter(
        (x) => x.rank_id === data.ranks[0].id,
      ).length,
      3,
    );
  });
  let archiveId;
  await t.test("Afgeschermd uploaden, downloaden en categorieën", async () => {
    const category = data.categories[0],
      form = new FormData();
    for (const [key, value] of Object.entries({
      title: "Dossier test",
      categoryId: category.id,
      note: "Vertrouwelijke notitie",
      description: "Testdocument",
    }))
      form.set(key, value);
    form.set(
      "file",
      new Blob(["Veilig tekstbestand"], { type: "text/plain" }),
      "dossier.txt",
    );
    const created = await command.request("/api/archive", {
      method: "POST",
      body: form,
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    archiveId = created.data.id;
    assert.equal(
      (await command.request("/api/archive/" + archiveId + "/file")).data,
      "Veilig tekstbestand",
    );
    assert.equal(
      (await agent.request("/api/archive/" + archiveId + "/file")).status,
      403,
    );
    assert.equal(
      (await anon.request("/api/archive/" + archiveId + "/file")).status,
      401,
    );
    assert.equal(
      (
        await command.request("/api/categories/" + category.id, {
          method: "DELETE",
          body: {},
        })
      ).status,
      409,
    );
    const malicious = new FormData();
    malicious.set("title", "Verboden");
    malicious.set("categoryId", category.id);
    malicious.set(
      "file",
      new Blob(['<svg onload="alert(1)"></svg>']),
      "foto.png",
    );
    assert.equal(
      (
        await command.request("/api/archive", {
          method: "POST",
          body: malicious,
        })
      ).status,
      400,
    );
    const tooBig = new FormData();
    tooBig.set("title", "Groot");
    tooBig.set("categoryId", category.id);
    tooBig.set(
      "file",
      new Blob([new Uint8Array(5 * 1024 * 1024 + 1)]),
      "groot.txt",
    );
    assert.equal(
      (await command.request("/api/archive", { method: "POST", body: tooBig }))
        .status,
      413,
    );
    assert.equal(
      (
        await command.request("/api/archive/" + archiveId, {
          method: "DELETE",
          body: {},
        })
      ).status,
      200,
    );
    assert.equal(
      (await command.request("/api/archive/" + archiveId + "/file")).status,
      404,
    );
  });
  await t.test("CSRF en externe herkomst worden geweigerd", async () => {
    assert.equal(
      (
        await command.request("/api/personnel/" + personId, {
          method: "DELETE",
          body: {},
          token: "fout",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await command.request("/api/personnel/" + personId, {
          method: "DELETE",
          body: {},
          origin: "https://aanvaller.test",
        })
      ).status,
      403,
    );
  });
  await t.test(
    "Beheeraccounts, tijdelijk wachtwoord en sessie-intrekking",
    async () => {
      const newPassword = "Nieuw-TestPassword-2026!";
      const created = await admin.request("/api/accounts", {
        method: "POST",
        body: {
          username: "nieuw",
          discordId: "990000000000000009",
          password: newPassword,
        },
      });
      assert.equal(created.status, 201);
      const newcomer = client();
      assert.equal((await newcomer.login("nieuw", newPassword)).status, 200);
      assert.equal((await newcomer.request("/api/bootstrap")).status, 403);
      assert.equal(
        (
          await newcomer.request("/api/password", {
            method: "POST",
            body: {
              currentPassword: newPassword,
              newPassword: "Gewijzigd-TestPassword-2026!",
            },
          })
        ).status,
        200,
      );
      assert.equal((await newcomer.request("/api/bootstrap")).status, 200);
      assert.equal(
        (
          await admin.request("/api/accounts/" + created.data.id, {
            method: "PUT",
            body: { enabled: false },
          })
        ).status,
        200,
      );
      assert.equal((await newcomer.request("/api/me")).status, 401);
    },
  );
  await t.test(
    "Verlies van Discord-rol trekt ook rechtstreekse API-toegang in",
    async () => {
      members.agent = [];
      assert.equal((await agent.request("/api/bootstrap")).status, 403);
      members.agent = config.roles.police;
    },
  );
  await t.test(
    "Audit registreert wijzigingen zonder wachtwoorden of tokens",
    async () => {
      const result = (await admin.request("/api/bootstrap")).data;
      assert.ok(result.audit.some((x) => x.action === "personeel.toegevoegd"));
      assert.ok(result.audit.some((x) => x.action === "archief.toegevoegd"));
      const serialized = JSON.stringify(result.audit);
      assert.ok(!serialized.includes(password));
      assert.ok(!serialized.includes("scrypt$"));
      assert.ok(!serialized.includes("accessToken"));
    },
  );
  await t.test("Afmelden maakt de sessie ongeldig", async () => {
    assert.equal(
      (await command.request("/auth/logout", { method: "POST", body: {} }))
        .status,
      200,
    );
    assert.equal((await command.request("/api/bootstrap")).status, 401);
  });
  await t.test(
    "Gegevens zijn via een nieuwe databaseverbinding beschikbaar",
    () => {
      const second = openDatabase(config);
      assert.equal(
        second
          .prepare("SELECT discord_name FROM personnel WHERE id=?")
          .get(personId).discord_name,
        "Test Agent",
      );
      second.close();
    },
  );
  await t.test(
    "OAuth-start bindt de flow; willekeurige callbacks worden geweigerd",
    async () => {
      config.demo = false;
      config.clientId = "1509476480638386206";
      config.clientSecret = "test-only";
      const oauth = client();
      const result = await oauth.login("admin");
      assert.equal(result.data.oauthUrl, "/auth/discord/start");
      const start = await oauth.request("/auth/discord/start");
      assert.equal(start.status, 302);
      const target = new URL(start.headers.get("location"));
      assert.equal(target.origin, "https://discord.com");
      assert.equal(
        target.searchParams.get("scope"),
        "identify guilds.members.read",
      );
      const bad = await oauth.request(
        "/auth/discord/callback?code=fake&state=ongeldig",
      );
      assert.equal(bad.status, 302);
      assert.ok(
        bad.headers.get("location").startsWith("/login.html?loginError="),
      );
      assert.equal((await oauth.request("/api/me")).status, 401);
    },
  );
});
test("Cryptografie en beperkte dienstrollen", () => {
  const key = randomBytes(32),
    value = { accessToken: "geheim", refreshToken: "ook-geheim" },
    sealed = encrypt(value, key);
  assert.deepEqual(decrypt(sealed, key), value);
  assert.throws(() => decrypt(sealed, randomBytes(32)));
  const settings = {
    roles: { admin: ["1"], police: ["2"], command: ["3"], ambulance: ["4"] },
    grants: {},
    ambulanceEnabled: true,
  };
  assert.equal(permissions(["2"], settings).policeWrite, false);
  assert.equal(permissions(["3"], settings).policeWrite, true);
  assert.equal(permissions(["4"], settings).policeRead, false);
  assert.equal(permissions(["4"], settings).ambulance, true);
  const owner = permissions(
    ["owner-id"],
    { ...settings, ambulanceEnabled: false },
    ["owner-id", "second-owner-id"],
  );
  assert.equal(owner.owner, true);
  assert.equal(owner.admin, true);
  assert.equal(owner.policeWrite, true);
  assert.equal(owner.archive, true);
  assert.equal(owner.audit, true);
  assert.equal(owner.accounts, true);
  assert.equal(owner.settings, true);
  assert.equal(owner.ambulance, true);
  assert.equal(
    permissions(["second-owner-id"], settings, ["owner-id", "second-owner-id"])
      .owner,
    true,
  );
});

test("Discord-controle herstelt van rate limits en hergebruikt recente rollen", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gov-oauth-test-"));
  const config = {
    dataDir,
    key: randomBytes(32),
    production: false,
    demo: false,
    discordReady: true,
    origin: "",
    clientId: "test-client",
    clientSecret: "test-secret",
    guildId: "1402056739985162394",
    roles: {
      admin: ["1519394041165516911"],
      police: ["1519394082277953679"],
      command: ["1519394051760066660"],
      ambulance: [],
    },
  };
  const db = openDatabase(config);
  const password = "Local-OAuth-Test-Password-2026!";
  const discordId = "990000000000000001";
  db.prepare("INSERT INTO users VALUES(?,?,?,?,1,0,?)").run(
    "oauth-test-user",
    "oauth-test",
    discordId,
    await hashPassword(password),
    timestamp(),
  );
  let identityCalls = 0;
  let memberCalls = 0;
  const request = async (input) => {
    const url = new URL(input);
    if (url.pathname === "/api/v10/oauth2/token")
      return new Response(
        JSON.stringify({
          access_token: "test-access-token",
          refresh_token: "test-refresh-token",
          expires_in: 3600,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    if (url.pathname === "/api/v10/users/@me") {
      identityCalls++;
      if (identityCalls === 1)
        return new Response(JSON.stringify({ message: "rate limited" }), {
          status: 429,
          headers: {
            "content-type": "application/json",
            "retry-after": "0",
          },
        });
      return new Response(
        JSON.stringify({ id: discordId, username: "oauth-test" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.pathname.endsWith("/member")) {
      memberCalls++;
      return new Response(JSON.stringify({ roles: config.roles.admin }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error("Unexpected Discord API request");
  };
  const service = await createApp(config, { db, request });
  const server = service.app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = "http://127.0.0.1:" + server.address().port;
  config.origin = base;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    service.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const cookies = new Map();
  async function send(route, { method = "GET", body } = {}) {
    const headers = {};
    if (cookies.size)
      headers.Cookie = [...cookies]
        .map(([name, value]) => name + "=" + value)
        .join("; ");
    if (method !== "GET") headers.Origin = base;
    if (body) headers["Content-Type"] = "application/json";
    const response = await fetch(base + route, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      redirect: "manual",
    });
    for (const entry of response.headers.getSetCookie()) {
      const [cookie] = entry.split(";");
      const index = cookie.indexOf("=");
      const name = cookie.slice(0, index);
      const value = cookie.slice(index + 1);
      if (value) cookies.set(name, value);
      else cookies.delete(name);
    }
    const data = response.headers
      .get("content-type")
      ?.includes("application/json")
      ? await response.json()
      : await response.text();
    return { status: response.status, data, headers: response.headers };
  }

  const login = await send("/auth/login", {
    method: "POST",
    body: { username: "oauth-test", password },
  });
  assert.equal(login.status, 200);
  assert.equal(login.data.oauthUrl, "/auth/discord/start");
  const start = await send("/auth/discord/start");
  assert.equal(start.status, 302);
  const state = new URL(start.headers.get("location")).searchParams.get(
    "state",
  );
  const callback = await send(
    "/auth/discord/callback?code=test-code&state=" + encodeURIComponent(state),
  );
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get("location"), "/");
  assert.equal((await send("/api/me")).status, 200);
  assert.equal((await send("/api/me")).status, 200);
  assert.equal(identityCalls, 2);
  assert.equal(memberCalls, 1);
});
