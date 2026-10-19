import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import serverless from "serverless-http";
import {
  bridgeRequest,
  toLambdaEvent,
  toWebResponse,
} from "../server/netlify-function-adapter.mjs";

test("Netlify modern requests become the Express paths expected by the portal", async () => {
  const request = new Request(
    "https://overheid.amsterdamrp.nl/.netlify/functions/portal/health?check=1",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "flow=abc",
        "x-forwarded-for": "192.0.2.4, 10.0.0.1",
      },
      body: JSON.stringify({ ready: true }),
    },
  );
  const event = await toLambdaEvent(request, { requestId: "netlify-test" });

  assert.equal(event.version, "2.0");
  assert.equal(event.rawPath, "/api/health");
  assert.equal(event.rawQueryString, "check=1");
  assert.equal(event.requestContext.http.method, "POST");
  assert.equal(event.requestContext.http.sourceIp, "192.0.2.4");
  assert.equal(event.requestContext.requestId, "netlify-test");
  assert.deepEqual(JSON.parse(Buffer.from(event.body, "base64").toString()), {
    ready: true,
  });
  assert.equal(event.headers.cookie, "flow=abc");
});

test("Netlify auth rewrites become Express auth routes", async () => {
  const request = new Request(
    "https://overheid.amsterdamrp.nl/.netlify/functions/portal/discord/start",
  );
  const event = await toLambdaEvent(request);
  assert.equal(event.rawPath, "/auth/discord/start");
});

test("the bridge routes a Netlify request through Express and preserves cookies", async () => {
  const app = express();
  app.use(express.json());
  app.post("/api/first-account", (req, res) => {
    res.cookie("session", "token", { httpOnly: true, secure: true });
    res.status(201).json({ path: req.path, body: req.body });
  });
  const request = new Request(
    "https://overheid.amsterdamrp.nl/.netlify/functions/portal/first-account?setup=1",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "Gilles" }),
    },
  );
  const response = await bridgeRequest(request, {}, serverless(app));

  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    path: "/api/first-account",
    body: { username: "Gilles" },
  });
  assert.match(response.headers.get("set-cookie"), /session=token/);
});

test("binary proxy responses are decoded for the Netlify web response", () => {
  const response = toWebResponse({
    statusCode: 200,
    headers: { "content-type": "application/octet-stream" },
    body: Buffer.from([0, 1, 2]).toString("base64"),
    isBase64Encoded: true,
  });
  return response
    .arrayBuffer()
    .then((body) => assert.deepEqual([...new Uint8Array(body)], [0, 1, 2]));
});
