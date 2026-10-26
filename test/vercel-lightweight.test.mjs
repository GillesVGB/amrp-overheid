import assert from "node:assert/strict";
import test from "node:test";
import { createLightweightResponse } from "../server/vercel-lightweight.mjs";

test("public creator requests need neither app initialization nor a database", async () => {
  const handle = createLightweightResponse({
    creator: async () => ({ discordId: "960090714950225970", avatarUrl: null }),
    getPool() {
      assert.fail("No database for the public avatar");
    },
    getConfig() {
      assert.fail("No private config for the public avatar");
    },
  });
  const response = await handle(new Request("https://portal.test/api/creator"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "public, max-age=60");
});

test("public maintenance caches only the public projection; legacy data falls back", async () => {
  let state = { maintenance: { enabled: false, reason: "", updatedAt: null } };
  const handle = createLightweightResponse({
    getPool: async () => ({}),
    maintenance: async () => state,
  });
  const response = await handle(
    new Request("https://portal.test/api/site-status"),
  );
  assert.deepEqual(await response.json(), state);
  assert.equal(
    response.headers.get("vercel-cdn-cache-control"),
    "public, s-maxage=15",
  );
  state = null;
  assert.equal(
    await handle(new Request("https://portal.test/api/site-status")),
    null,
  );
});

test("private changes use their own authentication and writes/private pages stay on the main path", async () => {
  const handle = createLightweightResponse({
    getPool: async () => ({}),
    getConfig: async () => ({}),
    revision: async () =>
      Response.json(
        { revision: "4" },
        { headers: { "Cache-Control": "private, no-store" } },
      ),
  });
  const response = await handle(new Request("https://portal.test/api/changes"));
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const identity = await handle(new Request("https://portal.test/api/me"));
  assert.equal(identity.headers.get("cache-control"), "private, no-store");
  for (const [method, path] of [
    ["POST", "/api/changes"],
    ["GET", "/api/users"],
    ["PUT", "/api/site-status"],
    ["GET", "/api/creator/private"],
  ])
    assert.equal(
      await handle(new Request("https://portal.test" + path, { method })),
      null,
    );
});
