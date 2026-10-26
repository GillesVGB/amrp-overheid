import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { del, get, put } from "@vercel/blob";
import serverless from "serverless-http";
import { createApp } from "./app.mjs";
import { configFromEnv } from "./config.mjs";
import { openDatabase } from "./database.mjs";
import { bridgeVercelRequest } from "./vercel-function-adapter.mjs";
import { withPostgresPortalState } from "./postgres-state.mjs";
import { maintenanceState } from "./maintenance.mjs";
import { readPublicMaintenance } from "./public-maintenance.mjs";
import { createPublicVercelResponse } from "./vercel-public.mjs";
import { vercelDatabaseOptions, vercelDatabasePool } from "./vercel-database.mjs";

const templateDir = fs.mkdtempSync(path.join(os.tmpdir(), "amrp-template-"));
const config = configFromEnv({
  ...process.env,
  NODE_ENV: "production",
  DATA_DIR: templateDir,
});
const { protectPublicTables } = vercelDatabaseOptions();
config.protectPublicTables = protectPublicTables;

const pool = await vercelDatabasePool();
const databaseContext = new AsyncLocalStorage();
const templateDb = openDatabase(config);
const db = {
  prepare(...args) {
    return (databaseContext.getStore()?.db || templateDb).prepare(...args);
  },
  exec(...args) {
    return (databaseContext.getStore()?.db || templateDb).exec(...args);
  },
  close() {},
};

const archiveFiles = {
  async put(name, buffer) {
    await put(name, buffer, {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/octet-stream",
    });
  },
  async get(name) {
    const result = await get(name, { access: "private" });
    if (!result || result.statusCode !== 200 || !result.stream) return null;
    return Buffer.from(await new Response(result.stream).arrayBuffer());
  },
  async delete(name) {
    await del(name, { access: "private" });
  },
};

const portal = await createApp(config, {
  db,
  archiveFiles,
  getRevision: currentPortalRevision,
  serverless: true,
  bootstrapSecret: process.env.INITIAL_SETUP_KEY || "",
});
const proxy = serverless(portal.app, { binary: true });
const publicResponse = createPublicVercelResponse({
  proxy,
  readMaintenance: () =>
    readPublicMaintenance(pool, () =>
      withPortalState(() => ({ maintenance: maintenanceState(db) })),
    ),
});

export async function withPortalState(callback) {
  const { result, afterCommit } = await withPostgresPortalState(
    config,
    async (requestDb, { revision }) => {
      const now = Date.now();
      requestDb.prepare("DELETE FROM auth_flows WHERE expires_at<?").run(now);
      requestDb.prepare("DELETE FROM signup_flows WHERE expires_at<?").run(now);
      requestDb
        .prepare("DELETE FROM discord_login_flows WHERE expires_at<?")
        .run(now);
      requestDb.prepare("DELETE FROM sessions WHERE expires_at<?").run(now);
      requestDb.prepare("DELETE FROM rate_limits WHERE expires_at<?").run(now);
      return databaseContext.run(
        { db: requestDb, revision, afterCommit: [] },
        async () => {
          const request = databaseContext.getStore();
          const result = await callback();
          return { result, afterCommit: request.afterCommit };
        },
      );
    },
    { pool },
  );
  for (const action of afterCommit)
    await action().catch(() =>
      console.error("Een archiefbestand kon niet worden opgeruimd."),
    );
  return result;
}

export function currentPortalRevision() {
  return databaseContext.getStore()?.revision ?? 0;
}

export function runDiscordSync() {
  return withPortalState(() => portal.roster.run());
}

export function handleVercelRequest(req, res) {
  return bridgeVercelRequest(req, res, {
    origin: config.origin,
    withPortalState,
    proxy,
    publicResponse,
  });
}
