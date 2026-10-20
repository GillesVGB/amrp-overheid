import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { configFromEnv } from "../server/config.mjs";

function productionEnv(dataDir, appOrigin) {
  return {
    NODE_ENV: "production",
    APP_ORIGIN: appOrigin,
    DATA_DIR: dataDir,
    TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    DISCORD_CLIENT_ID: "1509476480638386206",
    DISCORD_CLIENT_SECRET: "test-secret",
    DISCORD_GUILD_ID: "1402056739985162394",
    ROLE_ADMIN: "1519394041165516911",
  };
}

test("APP_ORIGIN accepts a trailing slash and normalizes to the origin", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "origin-test-"));
  const config = configFromEnv(
    productionEnv(dataDir, "https://overheid.amsterdamrp.nl/"),
  );
  assert.equal(config.origin, "https://overheid.amsterdamrp.nl");
});

test("APP_ORIGIN rejects paths beyond the origin", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "origin-test-"));
  assert.throws(
    () => configFromEnv(productionEnv(dataDir, "https://overheid.amsterdamrp.nl/login")),
    /APP_ORIGIN moet één origin zonder pad zijn/,
  );
});
