import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../server/database.mjs";
import {
  parseCsv,
  previewCallsignImport,
  importCallsigns,
} from "../server/callsign-import.mjs";

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gov-import-test-"));
  const db = openDatabase({ dataDir, roles: {} });
  t.after(() => {
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const rank = { id: "test-rank", code: "TEST", label: "Testagent" };
  db.prepare(
    "INSERT INTO ranks(id,code,label,capacity,special,position) VALUES(?,?,?,0,0,99)",
  ).run(rank.id, rank.code, rank.label);
  return { db, rank, actor: { id: "import-test", username: "Testbeheerder" } };
}

test("CSV parser supports BOM, comma/semicolon, escaped quotes and embedded line breaks", () => {
  assert.deepEqual(
    parseCsv(
      '\uFEFFRoepnummer,Rang,Opmerking\r\n"[11, 01 ★★★]",Agent,"regel 1\nregel 2"\r\n"Unit ""Alpha""",Agent,"komma, puntkomma;"',
    ),
    [
      ["Roepnummer", "Rang", "Opmerking"],
      ["[11, 01 ★★★]", "Agent", "regel 1\nregel 2"],
      ['Unit "Alpha"', "Agent", "komma, puntkomma;"],
    ],
  );
  assert.deepEqual(parseCsv('Roepnummer;Rang\n"[11;01 🚓]";Testagent'), [
    ["Roepnummer", "Rang"],
    ["[11;01 🚓]", "Testagent"],
  ]);
  assert.throws(
    () => parseCsv('Roepnummer,Rang\n"unfinished,Agent'),
    /niet afgesloten/,
  );
  assert.throws(
    () => parseCsv('Roepnummer,Rang\n"closed"extra,Agent'),
    /Ongeldige tekens/,
  );
});

test("preview does not write; import preserves Unicode and audits one successful batch", (t) => {
  const { db, rank, actor } = fixture(t);
  const csv = `Roepnummer;Rang\n[11-01 ★★★];${rank.code}\n🚑 12-α;${rank.label}`;
  const preview = previewCallsignImport(db, csv);
  assert.equal(preview.valid, 2);
  assert.equal(preview.invalid, 0);
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM callsigns WHERE rank_id=?").get(rank.id)
      .n,
    0,
  );
  assert.deepEqual(importCallsigns(db, actor, csv), { imported: 2 });
  assert.deepEqual(
    db
      .prepare(
        "SELECT number,slot FROM callsigns WHERE rank_id=? ORDER BY slot",
      )
      .all(rank.id)
      .map((row) => ({ ...row })),
    [
      { number: "[11-01 ★★★]", slot: 1 },
      { number: "🚑 12-α", slot: 2 },
    ],
  );
  const log = db
    .prepare("SELECT * FROM audit WHERE action='roepnummer.csv_geimporteerd'")
    .all();
  assert.equal(log.length, 1);
  assert.equal(log[0].actor_id, actor.id);
  assert.deepEqual(JSON.parse(log[0].after_json), { count: 2 });
  assert.equal(
    db.prepare("SELECT capacity FROM ranks WHERE id=?").get(rank.id).capacity,
    2,
  );
});

test("duplicates already saved or repeated in file reject the entire import without an audit", (t) => {
  const { db, rank, actor } = fixture(t);
  db.prepare(
    "INSERT INTO callsigns(id,rank_id,number,slot) VALUES('existing',?,'EXISTING',1)",
  ).run(rank.id);
  for (const csv of [
    `Roepnummer,Rang\nVALID,${rank.code}\nEXISTING,${rank.code}`,
    `Roepnummer,Rang\nDUPLICATE,${rank.code}\nDUPLICATE,${rank.code}`,
    `Roepnummer,Rang\nVALID,${rank.code}\nUNKNOWN,unmapped`,
  ]) {
    assert.ok(previewCallsignImport(db, csv).invalid > 0);
    assert.throws(
      () => importCallsigns(db, actor, csv),
      (error) => error.status === 400,
    );
    assert.equal(
      db
        .prepare("SELECT COUNT(*) n FROM callsigns WHERE rank_id=?")
        .get(rank.id).n,
      1,
    );
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) n FROM audit WHERE action='roepnummer.csv_geimporteerd'",
        )
        .get().n,
      0,
    );
  }
});

test("rank limit and file limit prevent overflow and all-or-nothing import preserves capacity", (t) => {
  const { db, rank, actor } = fixture(t);
  const insert = db.prepare(
    "INSERT INTO callsigns(id,rank_id,number,slot) VALUES(?,?,?,?)",
  );
  for (let i = 1; i <= 499; i++) insert.run("slot" + i, rank.id, "unit" + i, i);
  const csv = `Roepnummer,Rang\nLAST,${rank.code}\nOVERFLOW,${rank.code}`;
  const preview = previewCallsignImport(db, csv);
  assert.equal(preview.valid, 1);
  assert.equal(preview.invalid, 1);
  assert.match(preview.rows[1].error, /500/);
  assert.throws(
    () => importCallsigns(db, actor, csv),
    (error) => error.status === 400,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM callsigns WHERE rank_id=?").get(rank.id)
      .n,
    499,
  );
  importCallsigns(db, actor, `Roepnummer,Rang\nLAST,${rank.id}`);
  assert.equal(
    db.prepare("SELECT capacity FROM ranks WHERE id=?").get(rank.id).capacity,
    500,
  );
  assert.throws(
    () =>
      parseCsv(
        "Roepnummer,Rang\n" +
          Array.from({ length: 501 }, (_, i) => `unit${i},TEST`).join("\n"),
      ),
    /1 tot 500/,
  );
});

test("multiline or oversized callsigns are shown as invalid before import", (t) => {
  const { db, rank } = fixture(t);
  const preview = previewCallsignImport(
    db,
    `Roepnummer,Rang\n"line1\nline2",${rank.code}\n${"x".repeat(41)},${rank.code}`,
  );
  assert.equal(preview.invalid, 2);
  assert.match(preview.rows[0].error, /één regel/);
});
