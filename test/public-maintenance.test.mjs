import assert from "node:assert/strict";
import test from "node:test";
import { readPublicMaintenance } from "../server/public-maintenance.mjs";

const updatedAt = "2026-10-24T00:00:00.000Z";
const state = {
  maintenance: { enabled: true, reason: "Databaseonderhoud", updatedAt },
};
const noFallback = () => {
  assert.fail("Een gemigreerd portaal mag geen volledige transactie starten.");
};

test("Publieke onderhoudsstatus leest alleen de gemarkeerde instellingenrij", async () => {
  const queries = [];
  const pool = {
    async query(sql) {
      queries.push(sql);
      return {
        rows: [
          { value: JSON.stringify({ ...state, privateSetting: "PRIVATE" }) },
        ],
      };
    },
    connect() {
      assert.fail("Geen expliciete verbinding of schrijftransactie nodig.");
    },
  };
  assert.deepEqual(await readPublicMaintenance(pool, noFallback), state);
  assert.equal(queries.length, 1);
  assert.match(queries[0], /^SELECT s\.value FROM public\.settings s/);
  assert.match(queries[0], /s\.id=1 AND EXISTS/);
  assert.match(queries[0], /public\.amrp_portal_meta WHERE id=1/);
});

test("Onderhoud uitschakelen en een reden aanpassen zijn bij de volgende lezing zichtbaar", async () => {
  let stored = structuredClone(state);
  const pool = {
    async query() {
      return { rows: [{ value: JSON.stringify(stored) }] };
    },
  };
  assert.equal(
    (await readPublicMaintenance(pool, noFallback)).maintenance.enabled,
    true,
  );
  stored.maintenance.reason = "Een bijgewerkte reden";
  assert.equal(
    (await readPublicMaintenance(pool, noFallback)).maintenance.reason,
    "Een bijgewerkte reden",
  );
  stored.maintenance.enabled = false;
  assert.deepEqual(await readPublicMaintenance(pool, noFallback), {
    maintenance: { enabled: false, reason: "", updatedAt },
  });
});

test("Bestaande instellingen zonder onderhoud blijven compatibel", async () => {
  const pool = {
    async query() {
      return { rows: [{ value: JSON.stringify({ title: "Portaal" }) }] };
    },
  };
  assert.deepEqual(await readPublicMaintenance(pool, noFallback), {
    maintenance: { enabled: false, reason: "", updatedAt: null },
  });
});

test("Ontbrekende tabel of migratiemarkering gebruikt één keer het bestaande veilige pad", async () => {
  for (const missing of ["table", "marker"]) {
    let calls = 0;
    const pool = {
      async query() {
        if (missing === "table")
          throw Object.assign(new Error("relation does not exist"), {
            code: "42P01",
          });
        return { rows: [] };
      },
    };
    assert.deepEqual(
      await readPublicMaintenance(pool, async () => {
        calls++;
        return state;
      }),
      state,
    );
    assert.equal(calls, 1);
  }
});

test("Quota- en verbindingsfouten gaan door zonder een onterecht open portaal te melden", async () => {
  for (const code of ["53000", "ECONNREFUSED", "42501"]) {
    const error = Object.assign(new Error("Database unavailable"), { code });
    const pool = {
      async query() {
        throw error;
      },
    };
    await assert.rejects(
      readPublicMaintenance(pool, noFallback),
      (actual) => actual === error,
    );
  }
});

test("Beschadigde instellingen worden niet als onderhoud uit teruggestuurd", async () => {
  for (const value of [
    "{broken",
    "null",
    "[]",
    '{"maintenance":{"enabled":"true"}}',
  ]) {
    const pool = {
      async query() {
        return { rows: [{ value }] };
      },
    };
    await assert.rejects(readPublicMaintenance(pool, noFallback));
  }
});
