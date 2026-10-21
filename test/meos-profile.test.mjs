import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { once } from "node:events";
import express from "express";
import { installMeosProfile } from "../server/meos-profile.mjs";

test("MEOS mag alleen met het koppeltoken één actief roepnummer lezen", async (t) => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE personnel(id TEXT,discord_id TEXT,active INTEGER);
    CREATE TABLE callsigns(personnel_id TEXT,number TEXT);
    INSERT INTO personnel VALUES('agent','99000000000000001',1),('inactive','99000000000000002',0),('unassigned','99000000000000003',1);
    INSERT INTO callsigns VALUES('agent','[11-01 ★★★]'),('inactive','12-01');`);
  const config = {
    meosProfileSecret: "a-long-test-only-token-for-local-verification",
  };
  const app = express();
  installMeosProfile(app, { db, config });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  });
  const base =
    "http://127.0.0.1:" +
    server.address().port +
    "/api/integrations/meos/profile/";
  const get = (id, token = config.meosProfileSecret) =>
    fetch(base + id, { headers: { Authorization: "Bearer " + token } });
  assert.equal((await get("99000000000000001", "wrong")).status, 401);
  assert.equal((await fetch(base + "99000000000000001")).status, 401);
  assert.equal((await get("invalid")).status, 400);
  assert.equal((await get("99000000000000002")).status, 404);
  assert.equal((await get("99000000000000999")).status, 404);
  const response = await get("99000000000000001");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    ok: true,
    profile: { discordId: "99000000000000001", callsign: "[11-01 ★★★]" },
  });
  assert.equal(
    (await (await get("99000000000000003")).json()).profile.callsign,
    "",
  );
  config.meosProfileSecret = "";
  assert.equal((await get("99000000000000001")).status, 503);
});
