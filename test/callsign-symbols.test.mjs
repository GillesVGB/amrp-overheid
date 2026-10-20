import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  listCallsigns,
  listPersonnel,
  openDatabase,
  saveCallsign,
  savePersonnel,
  sqliteError,
} from "../server/database.mjs";

test("Roepnummers met symbolen blijven bewaard en kunnen op ID worden toegewezen", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gov-callsign-test-"));
  const config = { dataDir, roles: {} };
  const actor = { id: "callsign-test", username: "Testbeheerder" };
  let db = openDatabase(config);
  t.after(() => {
    db?.close();
    assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir()));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const rank = db
    .prepare("SELECT id FROM ranks ORDER BY position DESC LIMIT 1")
    .get();
  const decorated = "[11-01 ★★★]";
  const callsignId = saveCallsign(db, actor, {
    rankId: rank.id,
    number: decorated,
  });
  assert.equal(
    listCallsigns(db).find((row) => row.id === callsignId).number,
    decorated,
  );

  const person = savePersonnel(db, actor, {
    discordId: "980000000000000001",
    discordName: "Test Agent",
    rankId: rank.id,
    callsignId,
    place: "Centrum",
  });
  assert.equal(
    listPersonnel(db).find((row) => row.id === person.id).callsign,
    decorated,
  );

  const edited = "🚓 11-01 / A";
  saveCallsign(
    db,
    actor,
    {
      number: edited,
      personnelId: person.id,
      place: "Centrum",
    },
    callsignId,
  );
  assert.throws(
    () => saveCallsign(db, actor, { rankId: rank.id, number: edited }),
    (error) => sqliteError(error).status === 409,
  );

  db.close();
  db = null;
  db = openDatabase(config);
  const restored = listCallsigns(db).find((row) => row.id === callsignId);
  assert.equal(restored.number, edited);
  assert.equal(restored.personnel_id, person.id);
  assert.equal(restored.place, "Centrum");
  const personnel = listPersonnel(db).find((row) => row.id === person.id);
  assert.equal(personnel.callsign_id, callsignId);
  assert.equal(personnel.callsign, edited);

  for (const separator of ["\r", "\n", "\t", "\u2028", "\u2029"]) {
    assert.throws(
      () =>
        saveCallsign(db, actor, {
          rankId: rank.id,
          number: `11${separator}01`,
        }),
      (error) => error.status === 400,
    );
  }
  assert.equal(
    listCallsigns(db).filter((row) => row.id === callsignId).length,
    1,
  );
});
