import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { withVercelErrorBoundary } from "../server/vercel-errors.mjs";
import { bridgeVercelRequest } from "../server/vercel-function-adapter.mjs";

function outgoing() {
  return {
    headers: {},
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    end(body) {
      this.body = body;
    },
  };
}

test("database quota errors return useful JSON503 without leaking secrets", async () => {
  const response = outgoing(),
    logs = [];
  await withVercelErrorBoundary(
    { method: "POST", headers: { "x-vercel-id": "cdg1::quota-test" } },
    response,
    async () => {
      throw Object.assign(
        new Error(
          "Your account or project has exceeded the quota. postgres://PRIVATE_PASSWORD",
        ),
        { code: "53000" },
      );
    },
    { log: (...args) => logs.push(args) },
  );
  assert.equal(response.statusCode, 503);
  assert.equal(
    response.headers["content-type"],
    "application/json; charset=utf-8",
  );
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["retry-after"], "60");
  const payload = JSON.parse(response.body);
  assert.equal(payload.code, "DATABASE_QUOTA_EXCEEDED");
  assert.match(payload.error, /Neon/);
  assert.equal(payload.requestId, "cdg1::quota-test");
  assert.doesNotMatch(JSON.stringify({ payload, logs }), /PRIVATE_PASSWORD/);
});

test("failed commits never send successful data or session cookies", async () => {
  const request = Readable.from([]),
    response = outgoing();
  Object.assign(request, { method: "POST", url: "/auth/login", headers: {} });
  await withVercelErrorBoundary(
    request,
    response,
    () =>
      bridgeVercelRequest(request, response, {
        origin: "https://government.test",
        proxy: async () => ({
          statusCode: 302,
          headers: { location: "/", "set-cookie": "session=UNCOMMITTED" },
        }),
        withPortalState: async (callback) => {
          await callback();
          throw Object.assign(new Error("connection reset after write"), {
            code: "ECONNRESET",
          });
        },
      }),
    { log() {} },
  );
  assert.equal(response.statusCode, 503);
  assert.equal(JSON.parse(response.body).code, "DATABASE_UNAVAILABLE");
  assert.equal(response.headers["set-cookie"], undefined);
  assert.equal(response.headers.location, undefined);
});

test("startup errors have a safe JSON500 and HEAD has no body", async () => {
  for (const method of ["GET", "HEAD"]) {
    const response = outgoing();
    await withVercelErrorBoundary(
      { method, headers: {} },
      response,
      async () => {
        throw Error("Missing key: PRIVATE_SECRET");
      },
      { log() {} },
    );
    assert.equal(response.statusCode, 500);
    if (method === "HEAD") assert.equal(response.body, null);
    else {
      assert.equal(JSON.parse(response.body).code, "SERVER_ERROR");
      assert.doesNotMatch(response.body, /PRIVATE_SECRET/);
    }
  }
});

test("successful requests retain their existing responses", async () => {
  const response = outgoing();
  await withVercelErrorBoundary(
    { headers: {} },
    response,
    async () => {
      response.statusCode = 201;
      response.end("created");
    },
    {
      log() {
        assert.fail("Successful requests must not be logged as errors");
      },
    },
  );
  assert.equal(response.statusCode, 201);
  assert.equal(response.body, "created");
});
