import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getStore } from "@netlify/blobs";
import { createApp } from "./app.mjs";
import { configFromEnv } from "./config.mjs";
import { openDatabase } from "./database.mjs";
import {
  netlifyArchiveFiles,
  withNetlifyPortalState,
} from "./netlify-state.mjs";

const templateDir = fs.mkdtempSync(path.join(os.tmpdir(), "amrp-template-"));
export const config = configFromEnv({
  ...process.env,
  NODE_ENV: "production",
  DATA_DIR: templateDir,
});
const templateDb = openDatabase(config);
const databaseContext = new AsyncLocalStorage();
const db = {
  prepare(...args) {
    return (databaseContext.getStore()?.db || templateDb).prepare(...args);
  },
  exec(...args) {
    return (databaseContext.getStore()?.db || templateDb).exec(...args);
  },
  close() {},
};
const persistentArchiveStore = netlifyArchiveFiles(
  getStore("amrp-archive-files", { region: "eu-central-1" }),
);
const archiveStore = {
  put: (...args) => persistentArchiveStore.put(...args),
  get: (...args) => persistentArchiveStore.get(...args),
  delete(name) {
    const request = databaseContext.getStore();
    if (request) {
      request.afterCommit.push(() => persistentArchiveStore.delete(name));
      return Promise.resolve();
    }
    return persistentArchiveStore.delete(name);
  },
};

const portal = await createApp(config, {
  db,
  archiveFiles: archiveStore,
  serverless: true,
  bootstrapSecret: process.env.NETLIFY_BOOTSTRAP_KEY || "",
});

export const app = portal.app;
export const roster = portal.roster;

export function withPortalState(callback) {
  return withNetlifyPortalState(config, async (requestDb) => {
    const now = Date.now();
    requestDb.prepare("DELETE FROM auth_flows WHERE expires_at<?").run(now);
    requestDb.prepare("DELETE FROM signup_flows WHERE expires_at<?").run(now);
    requestDb
      .prepare("DELETE FROM discord_login_flows WHERE expires_at<?")
      .run(now);
    requestDb.prepare("DELETE FROM sessions WHERE expires_at<?").run(now);
    requestDb.prepare("DELETE FROM rate_limits WHERE expires_at<?").run(now);
    const request = { db: requestDb, afterCommit: [] };
    const result = await databaseContext.run(request, callback);
    return { result, afterCommit: request.afterCommit };
  }).then(async ({ result, afterCommit }) => {
    for (const action of afterCommit)
      await action().catch(() =>
        console.error("Een archiefbestand kon niet worden opgeruimd."),
      );
    return result;
  });
}
