import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import express from "express";
import serverless from "serverless-http";
import {
  bridgeVercelRequest,
  toVercelWebRequest,
} from "../server/vercel-function-adapter.mjs";

const origin = "https://overheid-amrp.vercel.app";

function incoming(route, { method = "GET", body, parsedBody } = {}) {
  const request = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
  request.url = "/api/portal?__portal_route=" + encodeURIComponent(route);
  request.method = method;
  request.headers = {
    origin,
    "content-type": "application/json",
    cookie: "flow=test-flow",
  };
  if (parsedBody !== undefined) request.body = parsedBody;
  return request;
}

function outgoing() {
  return {
    statusCode: 200,
    headers: {},
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    end(body) {
      this.body = body;
    },
  };
}

test("rewritten Discord callback preserves code, state and issuer", () => {
  const request = incoming("/auth/discord/callback");
  request.url += "&code=fake-code&state=fake-state&iss=https%3A%2F%2Fdiscord.com";
  const converted = toVercelWebRequest(request, origin);
  const url = new URL(converted.url);
  assert.equal(url.pathname, "/auth/discord/callback");
  assert.equal(url.searchParams.get("code"), "fake-code");
  assert.equal(url.searchParams.get("state"), "fake-state");
  assert.equal(url.searchParams.get("iss"), "https://discord.com");
  assert.equal(url.searchParams.has("__portal_route"), false);
  assert.equal(converted.headers.get("cookie"), "flow=test-flow");
});

test("both raw and Vercel-parsed form bodies reach Express", async () => {
  const app = express();
  app.use(express.json());
  app.post("/auth/register", (req, res) => {
    assert.equal(req.get("origin"), origin);
    res.cookie("flow", "registered", { secure: true, httpOnly: true });
    res.json(req.body);
  });
  for (const options of [
    { body: JSON.stringify({ username: "agent" }) },
    { parsedBody: { username: "agent" } },
  ]) {
    const request = incoming("/auth/register", { method: "POST", ...options });
    const response = outgoing();
    await bridgeVercelRequest(request, response, {
      origin,
      proxy: serverless(app),
      withPortalState: async (callback) => callback(),
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.body.toString()), { username: "agent" });
    assert.match(response.headers["set-cookie"][0], /flow=registered/);
  }
});

test("nested API paths keep binary files and only respond after commit", async () => {
  const app = express();
  app.get("/api/archive/:id/file", (req, res) => {
    assert.equal(req.params.id, "document-42");
    res.type("application/octet-stream").send(Buffer.from([0, 255, 12]));
  });
  const response = outgoing();
  let committed = false;
  const end = response.end.bind(response);
  response.end = (body) => {
    assert.equal(committed, true);
    end(body);
  };
  await bridgeVercelRequest(incoming("/api/archive/document-42/file"), response, {
    origin,
    proxy: serverless(app, { binary: true }),
    withPortalState: async (callback) => {
      const result = await callback();
      committed = true;
      return result;
    },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual([...response.body], [0, 255, 12]);
});

test("OAuth redirects preserve multiple cookies through the Vercel bridge", async () => {
  const app = express();
  app.get("/auth/discord/callback", (req, res) => {
    res.cookie("session", "session-token", { secure: true, httpOnly: true });
    res.clearCookie("flow", { secure: true, httpOnly: true });
    res.redirect("/");
  });
  const response = outgoing();
  await bridgeVercelRequest(incoming("/auth/discord/callback"), response, {
    origin,
    proxy: serverless(app),
    withPortalState: async (callback) => callback(),
  });
  assert.equal(response.statusCode, 302);
  assert.equal(response.headers.location, "/");
  assert.equal(response.headers["set-cookie"].length, 2);
});

test("internal routing cannot replace an original API URL or target another host", () => {
  const direct = incoming("/auth/logout");
  direct.url = "/api/health?__portal_route=/auth/logout";
  assert.equal(new URL(toVercelWebRequest(direct, origin).url).pathname, "/api/health");
  assert.throws(() => toVercelWebRequest(incoming("https://other.example/auth/login"), origin));
  assert.throws(() => toVercelWebRequest(incoming("/auth/login?other=1"), origin));
});
