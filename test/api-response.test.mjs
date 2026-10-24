import test from "node:test";
import assert from "node:assert/strict";
import { createApi } from "../public/js/api.js";

function mockFetch(t, respond) {
  const original = globalThis.fetch;
  globalThis.fetch = respond;
  t.after(() => {
    globalThis.fetch = original;
  });
}

test("Platformfout als tekst geeft een begrijpelijke fout met HTTP-status", async (t) => {
  mockFetch(
    t,
    async () => new Response("A server error has occurred", { status: 500 }),
  );
  await assert.rejects(createApi()("/api/me"), (error) => {
    assert.equal(error.status, 500);
    assert.equal(error.code, "INVALID_SERVER_RESPONSE");
    assert.match(error.message, /HTTP 500/);
    assert.match(error.message, /Probeer het opnieuw/);
    assert.doesNotMatch(error.message, /Unexpected token|A server error/);
    assert.equal(error instanceof SyntaxError, false);
    return true;
  });
});

test("HTML in een succesvolle API-response wordt niet als geldige data gebruikt", async (t) => {
  mockFetch(
    t,
    async () =>
      new Response("<!doctype html><h1>Hosting error</h1>", {
        headers: { "Content-Type": "text/html" },
      }),
  );
  await assert.rejects(createApi()("/api/personnel"), (error) => {
    assert.equal(error.status, 200);
    assert.equal(error.code, "INVALID_SERVER_RESPONSE");
    assert.match(error.message, /ongeldig antwoord/);
    return true;
  });
});

test("JSON-fouten en CSRF-beveiliging blijven behouden", async (t) => {
  let options;
  mockFetch(t, async (_url, supplied) => {
    options = supplied;
    return Response.json(
      { error: "Geen toegang", code: "FORBIDDEN" },
      { status: 403 },
    );
  });
  const api = createApi({ getSession: () => ({ csrf: "test-csrf" }) });
  await assert.rejects(
    api("/api/settings", { method: "PUT", body: { enabled: true } }),
    (error) => {
      assert.equal(error.status, 403);
      assert.equal(error.code, "FORBIDDEN");
      assert.equal(error.message, "Geen toegang");
      return true;
    },
  );
  assert.equal(options.credentials, "same-origin");
  assert.equal(options.headers["X-CSRF-Token"], "test-csrf");
  assert.equal(options.headers["Content-Type"], "application/json");
  assert.equal(options.body, '{"enabled":true}');
});

test("Ongeldige 401-response blijft de verlopen sessie afhandelen", async (t) => {
  const unauthorized = [];
  mockFetch(t, async () => new Response("Unauthorized", { status: 401 }));
  const api = createApi({
    getSession: () => ({ csrf: "test-csrf" }),
    onUnauthorized: (message) => unauthorized.push(message),
  });
  await assert.rejects(api("/api/me"), { status: 401 });
  assert.equal(unauthorized.length, 1);
  assert.match(unauthorized[0], /HTTP 401/);
});

test("Databaselimiet behoudt de herstelinstructie en foutcode van de server", async (t) => {
  const message =
    "De databaselimiet is bereikt. Neem contact op met de beheerder.";
  mockFetch(t, async () =>
    Response.json(
      {
        error: message,
        code: "DATABASE_QUOTA_EXCEEDED",
      },
      { status: 503 },
    ),
  );
  await assert.rejects(createApi()("/auth/login", { method: "POST" }), {
    message,
    code: "DATABASE_QUOTA_EXCEEDED",
    status: 503,
  });
});

test("Onderhoudsresponse behoudt de redirect en beheerderslogin-uitzondering", async (t) => {
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const priorLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  const redirected = [];
  const location = { pathname: "/index.html", search: "" };
  Object.defineProperty(globalThis, "location", {
    value: location,
    configurable: true,
  });
  Object.defineProperty(globalThis, "window", {
    value: { top: { location: { replace: (url) => redirected.push(url) } } },
    configurable: true,
  });
  t.after(() => {
    if (priorWindow) Object.defineProperty(globalThis, "window", priorWindow);
    else delete globalThis.window;
    if (priorLocation)
      Object.defineProperty(globalThis, "location", priorLocation);
    else delete globalThis.location;
  });
  mockFetch(t, async () =>
    Response.json(
      { code: "SITE_MAINTENANCE", error: "Even onderhoud" },
      { status: 503 },
    ),
  );
  await assert.rejects(createApi()("/api/me"), {
    code: "SITE_MAINTENANCE",
    status: 503,
  });
  assert.deepEqual(redirected, ["/onderhoud.html"]);
  location.pathname = "/login.html";
  location.search = "?beheer=1";
  await assert.rejects(createApi()("/api/me"), {
    code: "SITE_MAINTENANCE",
    status: 503,
  });
  assert.deepEqual(redirected, ["/onderhoud.html"]);
});

test("Geldige JSON en lege 204-responses blijven succesvol", async (t) => {
  mockFetch(t, async (url) =>
    url === "/api/empty"
      ? new Response(null, { status: 204 })
      : Response.json({ ok: true }),
  );
  const api = createApi();
  assert.deepEqual(await api("/api/ok"), { ok: true });
  assert.equal(await api("/api/empty"), null);
});
