import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import express from "express";
import serverless from "serverless-http";
import { createPublicVercelResponse } from "../server/vercel-public.mjs";
import { bridgeVercelRequest } from "../server/vercel-function-adapter.mjs";

const origin = "https://government.test";
const maintenance = {
  maintenance: {
    enabled: true,
    reason: "Testonderhoud",
    updatedAt: "2026-10-24",
  },
};

test("creator and maintenance polling skip the full transaction, retaining real responses", async () => {
  const app = express();
  app.get("/api/creator", (_req, res) =>
    res
      .set("Cache-Control", "no-store")
      .json({ discordId: "960090714950225970", avatarUrl: null }),
  );
  const proxy = serverless(app);
  let maintenanceReads = 0;
  const publicResponse = createPublicVercelResponse({
    proxy,
    readMaintenance: async () => {
      maintenanceReads++;
      return maintenance;
    },
  });
  for (const route of ["/api/creator", "/api/site-status"]) {
    for (const method of ["GET", "HEAD"]) {
      const request = Readable.from([]);
      Object.assign(request, {
        method,
        url: "/api/portal?__portal_route=" + encodeURIComponent(route),
        headers: {},
      });
      const response = {
        headers: {},
        setHeader(name, value) {
          this.headers[name.toLowerCase()] = value;
        },
        end(body) {
          this.body = body;
        },
      };
      await bridgeVercelRequest(request, response, {
        origin,
        proxy,
        publicResponse,
        withPortalState() {
          assert.fail("Public polling must not load the full database");
        },
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers["cache-control"], "no-store");
      if (method === "HEAD") assert.equal(response.body, null);
      else if (route === "/api/site-status")
        assert.deepEqual(JSON.parse(response.body), maintenance);
      else
        assert.equal(JSON.parse(response.body).discordId, "960090714950225970");
    }
  }
  assert.equal(maintenanceReads, 2);
});

test("private routes, lookalikes and every write keep the normal transaction", async () => {
  const publicResponse = createPublicVercelResponse({
    proxy() {
      assert.fail("Must not invoke public proxy");
    },
    readMaintenance() {
      assert.fail("Must not read public state");
    },
  });
  for (const [method, route] of [
    ["GET", "/api/me"],
    ["GET", "/auth/login"],
    ["POST", "/api/creator"],
    ["PUT", "/api/site-status"],
    ["POST", "/auth/login"],
    ["GET", "/api/site-status/private"],
    ["GET", "/api/creator/"],
  ]) {
    assert.equal(
      await publicResponse(new Request(origin + route, { method }), {}),
      null,
    );
  }
});

test("database rejection cannot be replaced with a healthy maintenance response", async () => {
  const failure = Object.assign(
    new Error("Your account or project has exceeded the quota"),
    { code: "53000" },
  );
  const publicResponse = createPublicVercelResponse({
    proxy() {},
    readMaintenance() {
      throw failure;
    },
  });
  await assert.rejects(
    publicResponse(new Request(origin + "/api/site-status"), {}),
    (error) => error === failure,
  );
});
