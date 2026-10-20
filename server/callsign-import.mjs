import { audit, id, transaction } from "./database.mjs";
import { requireValue } from "./security.mjs";

// Handles quoted fields, embedded line breaks, BOM and the Dutch Excel delimiter.
export function parseCsv(source) {
  requireValue(
    typeof source === "string" && source.length <= 90000,
    400,
    "Kies een CSV-bestand van maximaal 90 kB.",
  );
  const input = source.replace(/^\uFEFF/, "");
  const first = input.split(/\r?\n/, 1)[0];
  const delimiter =
    (first.match(/;/g)?.length || 0) > (first.match(/,/g)?.length || 0)
      ? ";"
      : ",";
  const rows = [];
  let row = [],
    value = "",
    quoted = false,
    closed = false;
  for (let i = 0; i <= input.length; i++) {
    const c = input[i];
    if (quoted) {
      requireValue(
        c !== undefined,
        400,
        "Een aanhalingsteken in de CSV is niet afgesloten.",
      );
      if (c === '"' && input[i + 1] === '"') {
        value += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
        closed = true;
      } else value += c;
    } else if (c === '"' && !value && !closed) quoted = true;
    else if (c === delimiter || c === "\n" || c === "\r" || c === undefined) {
      row.push(value.trim());
      value = "";
      closed = false;
      if (c !== delimiter) {
        if (row.some(Boolean)) rows.push(row);
        row = [];
        if (c === "\r" && input[i + 1] === "\n") i++;
      }
    } else {
      requireValue(
        !closed || /\s/.test(c),
        400,
        "Ongeldige tekens na een afgesloten CSV-veld.",
      );
      requireValue(
        c !== '"',
        400,
        "Zet velden met aanhalingstekens tussen dubbele aanhalingstekens.",
      );
      if (!closed) value += c;
    }
  }
  requireValue(
    rows.length >= 2 && rows.length <= 501,
    400,
    "Gebruik een kopregel en 1 tot 500 roepnummers.",
  );
  return rows;
}
const normalize = (value) =>
  String(value).normalize("NFKC").toLowerCase().trim();
export function previewCallsignImport(db, csv) {
  const [header, ...records] = parseCsv(csv);
  const column = (...names) =>
    header.findIndex((h) => names.includes(normalize(h)));
  const numberCol = column("roepnummer", "number", "nummer"),
    rankCol = column("rang", "rank", "rankid", "rank_id");
  requireValue(
    numberCol >= 0 && rankCol >= 0,
    400,
    "De kopregel moet Roepnummer en Rang bevatten. Rang mag de naam, nummerreeks of het ID zijn.",
  );
  const ranks = db.prepare("SELECT * FROM ranks").all(),
    existing = db.prepare("SELECT rank_id,number FROM callsigns").all();
  const used = new Set(existing.map((x) => x.rank_id + "\0" + x.number));
  const slots = new Map(
    ranks.map((r) => [
      r.id,
      db
        .prepare(
          "SELECT COALESCE(MAX(slot),0) value FROM callsigns WHERE rank_id=?",
        )
        .get(r.id).value,
    ]),
  );
  const rows = records.map((record, index) => {
    const number = record[numberCol] || "",
      rankName = record[rankCol] || "";
    const matches = ranks.filter((r) =>
      [r.id, r.code, r.label].some((v) => normalize(v) === normalize(rankName)),
    );
    const rank = matches.length === 1 ? matches[0] : null;
    let error = "";
    if (!number || number.length > 40 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(number))
      error = "Roepnummer moet één regel van 1 tot 40 tekens zijn.";
    else if (!rank) error = "Rang niet gevonden of niet uniek.";
    else if (used.has(rank.id + "\0" + number))
      error = "Dubbel roepnummer binnen deze rang.";
    else if (slots.get(rank.id) >= 500)
      error = "Maximaal 500 roepnummers per rang.";
    if (!error) {
      used.add(rank.id + "\0" + number);
      slots.set(rank.id, slots.get(rank.id) + 1);
    }
    return {
      line: index + 2,
      number,
      rankId: rank?.id || "",
      rank: rank?.label || rankName,
      error,
    };
  });
  return {
    rows,
    valid: rows.filter((r) => !r.error).length,
    invalid: rows.filter((r) => r.error).length,
  };
}
export function importCallsigns(db, actor, csv) {
  return transaction(db, () => {
    const preview = previewCallsignImport(db, csv);
    requireValue(
      !preview.invalid,
      400,
      "Los alle fouten in het voorbeeld op voordat je importeert.",
    );
    const slots = new Map();
    for (const row of preview.rows) {
      const slot =
        (slots.get(row.rankId) ??
          db
            .prepare(
              "SELECT COALESCE(MAX(slot),0) value FROM callsigns WHERE rank_id=?",
            )
            .get(row.rankId).value) + 1;
      slots.set(row.rankId, slot);
      db.prepare(
        "INSERT INTO callsigns(id,rank_id,number,slot,personnel_id,place) VALUES(?,?,?,?,NULL,'')",
      ).run(id(), row.rankId, row.number, slot);
    }
    for (const [rankId, capacity] of slots)
      db.prepare("UPDATE ranks SET capacity=? WHERE id=?").run(
        capacity,
        rankId,
      );
    audit(db, actor, "roepnummer.csv_geimporteerd", "callsigns", null, {
      count: preview.valid,
    });
    return { imported: preview.valid };
  });
}
