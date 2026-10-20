import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import serverless from "serverless-http";
import { createApp } from "../server/app.mjs";
import { openDatabase, getSettings, timestamp } from "../server/database.mjs";
import { digest, encrypt } from "../server/security.mjs";
import { detectWorkspaceFile } from "../server/workspace.mjs";

test("Gedeelde werkplek: documenten, opleidingen en aanvragen respecteren afdelingen en eigenaarschap", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gov-workspace-"));
  const config = {
    dataDir,
    key: randomBytes(32),
    production: false,
    demo: true,
    origin: "",
    roles: {
      owner: ["101"],
      admin: ["102"],
      police: ["103"],
      command: ["104"],
      ambulance: ["105"],
    },
  };
  const db = openDatabase(config),
    settings = getSettings(db);
  settings.ambulanceEnabled = true;
  db.prepare("UPDATE settings SET value=? WHERE id=1").run(
    JSON.stringify(settings),
  );
  const roles = {
    owner: ["101"],
    agent: ["103"],
    other: ["103"],
    ambulance: ["105"],
  };
  const sessions = {};
  for (const [index, name] of Object.keys(roles).entries()) {
    const discordId = "99000000000000000" + index;
    db.prepare("INSERT INTO users VALUES(?,?,?,?,1,0,?)").run(
      name,
      name,
      discordId,
      "unused-test-hash",
      timestamp(),
    );
    const raw = "workspace-session-" + name;
    sessions[name] = raw;
    db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?,?)").run(
      digest(raw),
      name,
      "csrf-" + name,
      encrypt({ demoId: discordId, name }, config.key),
      Date.now() + 3600000,
      Date.now(),
    );
  }
  const objects = new Map();
  const service = await createApp(config, {
    db,
    serverless: true,
    discord: {
      async member(tokens) {
        return {
          identity: { id: tokens.demoId, username: tokens.name },
          roles: roles[tokens.name],
          tokens,
        };
      },
    },
    archiveFiles: {
      async put(name, bytes) {
        objects.set(name, bytes);
      },
      async get(name) {
        return objects.get(name) || null;
      },
      async delete(name) {
        objects.delete(name);
      },
    },
  });
  const handler = serverless(service.app);
  config.origin = "https://workspace.test";
  t.after(() => {
    service.close();
    assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir()));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  async function request(who, route, method = "GET", body, extraHeaders = {}) {
    const form = body instanceof FormData;
    const outgoing = new Request(config.origin + route, {
      method,
      headers: {
        ...(who ? { Cookie: "gov-session=" + sessions[who] } : {}),
        Origin: config.origin,
        "X-CSRF-Token": "csrf-" + who,
        ...(body && !form ? { "Content-Type": "application/json" } : {}),
        ...extraHeaders,
      },
      body: form ? body : body ? JSON.stringify(body) : undefined,
    });
    const url = new URL(outgoing.url),
      bytes = Buffer.from(await outgoing.arrayBuffer());
    const response = await handler(
      {
        httpMethod: method,
        path: url.pathname,
        queryStringParameters: Object.fromEntries(url.searchParams),
        headers: Object.fromEntries(outgoing.headers),
        body: bytes.toString("base64"),
        isBase64Encoded: true,
      },
      {},
    );
    const headers = new Headers(response.headers),
      value = response.isBase64Encoded
        ? Buffer.from(response.body, "base64").toString()
        : response.body;
    return {
      status: response.statusCode,
      data: headers.get("content-type")?.includes("json")
        ? JSON.parse(value)
        : value,
      headers,
    };
  }
  const endpoint = "/api/workspace";
  assert.equal((await request(null, endpoint + "/bootstrap")).status, 401);
  assert.equal(
    (
      await request("agent", endpoint + "/folders", "POST", {
        name: "Kan niet",
        service: "shared",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(
        "owner",
        endpoint + "/folders",
        "POST",
        { name: "CSRF", service: "shared" },
        { "X-CSRF-Token": "wrong" },
      )
    ).status,
    403,
  );
  const initial = await request("ambulance", endpoint + "/bootstrap");
  assert.equal(initial.status, 200);
  assert.ok(!initial.data.folders.some((x) => x.service === "police"));

  const folder = await request("owner", endpoint + "/folders", "POST", {
    name: "Rapporten",
    parent_id: "workspace-police",
    service: "police",
  });
  assert.equal(folder.status, 201);
  assert.equal(
    (
      await request("owner", endpoint + "/folders/" + folder.data.id, "PUT", {
        parent_id: folder.data.id,
      })
    ).status,
    400,
  );
  const doc = await request("agent", endpoint + "/documents", "POST", {
    title: "Rapport Centrum",
    folder_id: folder.data.id,
    template_key: "rapport",
    content: "Bevindingen Centrum",
    fields: {
      datum: "2026-10-20T16:00",
      locatie: "Centrum",
      bevindingen: "Voertuig aangetroffen",
    },
  });
  assert.equal(doc.status, 201);
  assert.equal(doc.data.canEdit, true);
  assert.equal(doc.data.storage_name, undefined);
  assert.equal(
    (
      await request("other", endpoint + "/documents/" + doc.data.id, "PUT", {
        title: "Andere eigenaar",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request("agent", endpoint + "/documents/" + doc.data.id, "PUT", {
        title: "Rapport Centrum gewijzigd",
      })
    ).status,
    200,
  );
  assert.equal(
    (await request("ambulance", endpoint + "/documents/" + doc.data.id)).status,
    403,
  );
  assert.equal(
    (await request("owner", endpoint + "/folders/" + folder.data.id, "DELETE"))
      .status,
    409,
  );
  const search = await request("agent", "/api/search?q=Centrum");
  assert.ok(search.data.results.some((x) => x.id === doc.data.id));
  const ambSearch = await request("ambulance", "/api/search?q=Centrum");
  assert.ok(!ambSearch.data.results.some((x) => x.id === doc.data.id));

  const form = new FormData();
  form.set("title", "Politiehandboek");
  form.set("folder_id", folder.data.id);
  form.set(
    "file",
    new Blob(["%PDF-1.7\nTest document"], { type: "application/pdf" }),
    "handboek.pdf",
  );
  const upload = await request("agent", endpoint + "/documents", "POST", form);
  assert.equal(upload.status, 201);
  assert.equal(objects.size, 1);
  assert.equal(
    (
      await request(
        "ambulance",
        endpoint + "/documents/" + upload.data.id + "/file",
      )
    ).status,
    403,
  );
  const download = await request(
    "agent",
    endpoint + "/documents/" + upload.data.id + "/file?inline=1",
  );
  assert.equal(download.status, 200);
  assert.equal(download.headers.get("content-disposition"), "inline");
  assert.equal(
    (
      await request(
        "other",
        endpoint + "/documents/" + upload.data.id,
        "DELETE",
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await request(
        "agent",
        endpoint + "/documents/" + upload.data.id,
        "DELETE",
      )
    ).status,
    200,
  );
  assert.equal(objects.size, 0);

  const course = await request("owner", endpoint + "/courses", "POST", {
    name: "EHBO",
    qualification: "Eerste hulp",
    valid_months: 12,
    service: "shared",
  });
  assert.equal(course.status, 201);
  assert.equal(
    (
      await request("agent", endpoint + "/courses", "POST", {
        name: "Verboden",
      })
    ).status,
    403,
  );
  const completion = await request("owner", endpoint + "/completions", "POST", {
    course_id: course.data.id,
    user_id: "agent",
    completed_on: "2026-10-20",
  });
  assert.equal(completion.status, 201);
  assert.equal(completion.data.expires_on, "2027-10-20");
  assert.equal(
    (
      await request("owner", endpoint + "/completions", "POST", {
        course_id: course.data.id,
        user_id: "agent",
        completed_on: "2026-13-20",
      })
    ).status,
    400,
  );
  assert.equal(
    (await request("owner", endpoint + "/courses/" + course.data.id, "DELETE"))
      .status,
    409,
  );

  const leave = await request("agent", endpoint + "/requests", "POST", {
    type: "leave",
    title: "Verlof",
    description: "Een vrije dag",
    start_date: "2026-11-01",
    end_date: "2026-11-02",
    user_id: "owner",
  });
  assert.equal(leave.status, 201);
  assert.equal(leave.data.user_id, "agent");
  assert.ok(
    !(await request("other", endpoint + "/bootstrap")).data.requests.some(
      (x) => x.id === leave.data.id,
    ),
  );
  assert.equal(
    (
      await request(
        "agent",
        endpoint + "/requests/" + leave.data.id + "/review",
        "PUT",
        { status: "approved", reason: "Zelf" },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await request(
        "owner",
        endpoint + "/requests/" + leave.data.id + "/review",
        "PUT",
        { status: "approved", reason: "Akkoord" },
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await request(
        "owner",
        endpoint + "/requests/" + leave.data.id + "/review",
        "PUT",
        { status: "rejected", reason: "Nogmaals" },
      )
    ).status,
    409,
  );

  assert.equal(
    (
      await request("agent", "/api/drafts/rapport", "PUT", {
        value: { title: "Concept", content: "Niet kwijt" },
      })
    ).status,
    200,
  );
  assert.equal((await request("other", "/api/drafts/rapport")).status, 404);
  assert.equal(
    (await request("agent", "/api/drafts/rapport")).data.value.content,
    "Niet kwijt",
  );
  assert.equal(
    (
      await request("agent", "/api/drafts/login", "PUT", {
        value: { password: "NO" },
      })
    ).status,
    400,
  );
  assert.equal(
    (await request("agent", "/api/drafts/rapport", "DELETE")).status,
    200,
  );
  assert.ok(
    db
      .prepare(
        "SELECT COUNT(*) count FROM audit WHERE action LIKE 'verkenner.%'",
      )
      .get().count >= 5,
  );
});

test("Documentdetectie vertrouwt niet op extensie of een MIME-header", () => {
  assert.equal(
    detectWorkspaceFile(Buffer.from("%PDF-1.7\n"), "handboek.pdf").mime,
    "application/pdf",
  );
  assert.throws(
    () =>
      detectWorkspaceFile(
        Buffer.from("<html><script>alert(1)</script></html>"),
        "fake.pdf",
      ),
    (e) => e.status === 400,
  );
  assert.throws(
    () =>
      detectWorkspaceFile(
        Buffer.from("Dit is geen Office-bestand"),
        "fake.docx",
      ),
    (e) => e.status === 400,
  );
  assert.throws(
    () => detectWorkspaceFile(Buffer.alloc(0), "leeg.txt"),
    (e) => e.status === 400,
  );
});
