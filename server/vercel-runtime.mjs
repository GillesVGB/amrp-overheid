import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { del, get, put } from "@vercel/blob";
import serverless from "serverless-http";
import { createApp } from "./app.mjs";
import { configFromEnv } from "./config.mjs";
import { openDatabase } from "./database.mjs";
import { withNetlifyPortalState } from "./netlify-state.mjs";

const templateDir = fs.mkdtempSync(path.join(os.tmpdir(), "amrp-template-"));
const config = configFromEnv({
  ...process.env,
  NODE_ENV: "production",
  DATA_DIR: templateDir,
});
const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL;
if (!connectionString)
  throw new Error("Koppel eerst een PostgreSQL-database aan dit Vercel-project.");

const pool = new Pool({
  connectionString,
  max: Number(process.env.DB_POOL_MAX || 3),
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 10000,
});
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
  serverless: true,
  bootstrapSecret: process.env.INITIAL_SETUP_KEY || "",
});
const proxy = serverless(portal.app);

export async function withPortalState(callback) {
  const { result, afterCommit } = await withNetlifyPortalState(
    config,
    async (requestDb) => {
      const now = Date.now();
      requestDb.prepare("DELETE FROM auth_flows WHERE expires_at<?").run(now);
      requestDb.prepare("DELETE FROM signup_flows WHERE expires_at<?").run(now);
      requestDb.prepare("DELETE FROM sessions WHERE expires_at<?").run(now);
      requestDb.prepare("DELETE FROM rate_limits WHERE expires_at<?").run(now);
      return databaseContext.run(
        { db: requestDb, afterCommit: [] },
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

export function runDiscordSync() {
  return withPortalState(() => portal.roster.run());
}

export async function handleVercelRequest(req, res, { authRoute = false } = {}) {
  if (authRoute) {
    const url = new URL(req.url, "http://vercel.local");
    url.pathname = url.pathname.replace(/^\/api\/auth(?=\/|$)/, "/auth");
    req.url = url.pathname + url.search;
  }
  return withPortalState(() => proxy(req, res));
}
