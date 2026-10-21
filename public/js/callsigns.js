export function nextCallsign(callsigns, rank) {
  const rows = callsigns.filter((row) => row.rank_id === rank.id);
  const previous = rows.reduce(
    (last, row) => (!last || row.slot > last.slot ? row : last),
    null,
  );
  if (!previous) return `${rank.code}-001`;
  const match = /^(.*?)(\d+)(\D*)$/u.exec(previous.number);
  if (!match) return "";
  const used = new Set(rows.map((row) => row.number));
  let value = BigInt(match[2]);
  let number;
  do {
    value += 1n;
    number = match[1] + String(value).padStart(match[2].length, "0") + match[3];
  } while (used.has(number));
  return number.length <= 40 ? number : "";
}
