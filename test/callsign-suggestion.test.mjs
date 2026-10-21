import test from "node:test";
import assert from "node:assert/strict";
import { nextCallsign } from "../public/js/callsigns.js";

test("Nieuwe roepnummers behouden de opmaak van de laatste regel in hun rang", () => {
  const rank = { id: "agent", code: "11" };
  const rows = [
    { rank_id: "agent", slot: 4, number: "[11-09 ★★★]" },
    { rank_id: "other", slot: 99, number: "99-099" },
    { rank_id: "agent", slot: 1, number: "[11-10 ★★★]" },
  ];
  assert.equal(nextCallsign(rows, rank), "[11-11 ★★★]");
  assert.equal(nextCallsign([], rank), "11-001");
  assert.equal(nextCallsign([{ rank_id: "agent", slot: 1, number: "🚓 11-099 / A" }], rank), "🚓 11-100 / A");
  assert.equal(nextCallsign([{ rank_id: "agent", slot: 1, number: "Commandant" }], rank), "");
});
