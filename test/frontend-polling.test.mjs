import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseHTML } from "linkedom";
import { createNotificationCenter } from "../public/js/notification-center.js";

const settle = () => new Promise((resolve) => setImmediate(resolve));

function browser(t, { embedded = false, app = "personal" } = {}) {
  const { window } = parseHTML(
    fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8"),
  );
  const intervals = [],
    calls = [],
    requests = [],
    messages = [],
    assigned = [],
    memory = new Map();
  let hidden = false,
    now = 1700000000000,
    revision = "1",
    maintenance = false;
  const parentWindow = embedded
    ? { postMessage: (message) => messages.push(message) }
    : window;
  const session = {
    user: {
      id: "person",
      username: "agent",
      discordId: "990000000000000001",
      mustChange: false,
    },
    csrf: "private-csrf",
    discordName: "Agent",
    permissions: {
      owner: true,
      admin: true,
      policeRead: true,
      ambulance: true,
    },
    settings: { name: "Amsterdam" },
  };
  const schedule = globalThis.setTimeout;
  const pending = [];
  const values = {
    window,
    CustomEvent: window.CustomEvent,
    document: window.document,
    parent: parentWindow,
    location: {
      origin: "https://overheid.test",
      pathname: "/",
      search: embedded ? `?window=1&app=${app}` : "",
      replace: (url) => assigned.push(url),
    },
    navigator: { onLine: true },
    history: { replaceState() {} },
    localStorage: {
      getItem: (key) => memory.get(key) || null,
      setItem: (key, value) => memory.set(key, value),
    },
    innerWidth: 1280,
    innerHeight: 850,
    setInterval: (callback, delay) => {
      intervals.push({ callback, delay });
      return intervals.length;
    },
    setTimeout: (callback, delay, ...args) => {
      const handle = schedule(callback, delay === 2000 ? 0 : delay, ...args);
      pending.push(handle);
      return handle;
    },
    fetch: async (url, options = {}) => {
      calls.push(url);
      requests.push({ url, options });
      if (url === "/api/me") return Response.json(session);
      if (url === "/api/preferences")
        return Response.json({ theme: "light", wallpaper: "bloom" });
      if (url === "/api/changes") return Response.json({ revision });
      if (url === "/api/notifications")
        return Response.json({ items: [], unread: 0 });
      if (url === "/api/workspace/bootstrap")
        return Response.json({
          folders: [],
          documents: [],
          permissions: { services: ["shared"], manage: false },
        });
      if (url === "/api/creator")
        return Response.json({
          discordId: "960090714950225970",
          avatarUrl:
            "https://cdn.discordapp.com/avatars/960090714950225970/test.png",
        });
      if (url === "/api/site-status")
        return Response.json({ maintenance: { enabled: maintenance } });
      throw Error(`Unexpected request: ${url}`);
    },
  };
  const originals = new Map();
  for (const [key, value] of Object.entries(values)) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      value,
      writable: true,
      configurable: true,
    });
  }
  const oldNow = Date.now;
  Date.now = () => now;
  Object.defineProperty(window.document, "hidden", {
    get: () => hidden,
    configurable: true,
  });
  const oldRect = window.HTMLElement.prototype.getBoundingClientRect;
  window.HTMLElement.prototype.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    width: 1280,
    height: 800,
  });
  t.after(() => {
    pending.forEach(clearTimeout);
    Date.now = oldNow;
    window.HTMLElement.prototype.getBoundingClientRect = oldRect;
    for (const [key, descriptor] of originals)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
  });
  return {
    window,
    document: window.document,
    parentWindow,
    calls,
    requests,
    intervals,
    messages,
    assigned,
    session,
    advance: (ms) => {
      now += ms;
    },
    revision: (value) => {
      revision = value;
    },
    maintenance: (value) => {
      maintenance = value;
    },
    hidden: (value) => {
      hidden = value;
    },
    click: (element) =>
      element.dispatchEvent(new window.Event("click", { bubbles: true })),
    message(data, source = parentWindow, origin = "https://overheid.test") {
      const event = new window.Event("message");
      Object.assign(event, { data, source, origin });
      window.dispatchEvent(event);
    },
    count: (url) => calls.filter((value) => value === url).length,
  };
}

test("Het hoofdbureaublad deelt één controlelus met alle eigen appvensters", async (t) => {
  const ui = browser(t);
  await import("../public/js/desktop.js?cpu-parent-test");
  await settle();
  assert.deepEqual(
    ui.intervals.map((item) => item.delay).sort((a, b) => a - b),
    [1000, 60000, 300000],
  );
  assert.equal(ui.count("/api/me"), 1);
  assert.equal(ui.count("/api/changes"), 1);
  assert.equal(ui.count("/api/notifications"), 1);

  for (const app of ["files", "training", "requests"])
    ui.click(ui.document.querySelector(`#pinned-apps [data-app="${app}"]`));
  await settle();
  const frames = [...ui.document.querySelectorAll(".managed-window iframe")];
  assert.equal(frames.length, 3);
  const delivered = frames.map((frame) => {
    const received = [],
      source = { postMessage: (message) => received.push(message) };
    Object.defineProperty(frame, "contentWindow", { value: source });
    ui.message({ type: "amrp-ready" }, source);
    return received;
  });
  for (const received of delivered) {
    assert.ok(
      received.some(
        (item) => item.type === "amrp-changes" && item.revision === "1",
      ),
    );
    assert.ok(
      received.some(
        (item) =>
          item.type === "amrp-session" && item.session.csrf === "private-csrf",
      ),
    );
  }
  ui.window.dispatchEvent(new ui.window.Event("focus"));
  ui.window.dispatchEvent(new ui.window.Event("focus"));
  await settle();
  assert.equal(
    ui.count("/api/me"),
    1,
    "Repeated focus does not bypass the session throttle",
  );
  assert.equal(ui.count("/api/changes"), 1);
  ui.advance(60000);
  ui.revision("2");
  await ui.intervals.find((item) => item.delay === 60000).callback();
  for (const received of delivered)
    assert.ok(
      received.some(
        (item) => item.type === "amrp-changes" && item.revision === "2",
      ),
    );
  assert.equal(
    ui.count("/api/changes"),
    2,
    "Three apps still share a single revision request",
  );
  assert.equal(
    ui.count("/api/notifications"),
    2,
    "Notifications follow changes instead of an independent timer",
  );
  ui.advance(60000);
  await ui.intervals.find((item) => item.delay === 60000).callback();
  assert.equal(
    ui.count("/api/notifications"),
    2,
    "Unchanged revisions do not reload notifications",
  );

  ui.hidden(true);
  ui.advance(300000);
  await ui.intervals.find((item) => item.delay === 60000).callback();
  await ui.intervals.find((item) => item.delay === 300000).callback();
  assert.equal(ui.count("/api/changes"), 3);
  assert.equal(ui.count("/api/me"), 1);
  ui.hidden(false);
  ui.document.dispatchEvent(new ui.window.Event("visibilitychange"));
  await settle();
  assert.equal(ui.count("/api/changes"), 4);
  assert.equal(ui.count("/api/me"), 2);
});

test("Appvensters pollen niet zelf, weigeren vreemde berichten en verwerken uitgestelde wijzigingen na herstellen", async (t) => {
  const ui = browser(t, { embedded: true, app: "files" });
  await import("../public/js/desktop.js?cpu-child-test");
  assert.deepEqual(
    ui.intervals.map((item) => item.delay),
    [1000],
  );
  assert.equal(
    ui.count("/api/me"),
    1,
    "Each app still authenticates itself on startup",
  );
  assert.equal(ui.count("/api/changes"), 0);
  assert.equal(ui.count("/api/workspace/bootstrap"), 1);
  ui.message({ type: "amrp-changes", revision: "1" });
  ui.message({ type: "amrp-changes", revision: "2" }, {}, "https://evil.test");
  await settle();
  assert.equal(ui.count("/api/workspace/bootstrap"), 1);
  ui.message({ type: "amrp-visibility", visible: false });
  ui.message({ type: "amrp-changes", revision: "2" });
  await settle();
  assert.equal(
    ui.count("/api/workspace/bootstrap"),
    1,
    "Minimized apps defer their data reload",
  );
  ui.message({ type: "amrp-visibility", visible: true });
  await settle();
  assert.equal(ui.count("/api/workspace/bootstrap"), 2);
  ui.hidden(true);
  ui.message({ type: "amrp-changes", revision: "3" });
  await settle();
  assert.equal(ui.count("/api/workspace/bootstrap"), 2);
  ui.hidden(false);
  ui.document.dispatchEvent(new ui.window.Event("visibilitychange"));
  await settle();
  assert.equal(ui.count("/api/workspace/bootstrap"), 3);
  ui.window.dispatchEvent(new ui.window.Event("focus"));
  await settle();
  assert.equal(
    ui.count("/api/me"),
    1,
    "Embedded focus does not recheck the shared session",
  );
  assert.equal(ui.count("/api/changes"), 0);
});

test("Een los meldingscentrum blijft actueel en openen vernieuwt direct zonder verborgen polling", async (t) => {
  const ui = browser(t);
  const center = createNotificationCenter({
    api: async (url) => {
      ui.calls.push(url);
      return { items: [], unread: 0 };
    },
    onOpen() {},
  });
  await settle();
  assert.equal(ui.intervals[0].delay, 60000);
  ui.advance(60000);
  await ui.intervals[0].callback();
  assert.equal(ui.count("/api/notifications"), 2);
  center.toggle();
  await settle();
  assert.equal(
    ui.count("/api/notifications"),
    3,
    "Opening is not delayed by the timer throttle",
  );
  ui.hidden(true);
  ui.advance(60000);
  await ui.intervals[0].callback();
  assert.equal(ui.count("/api/notifications"), 3);
});

test("Openbare onderhoudsstatus en profielfoto gebruiken caches en delen de onderhoudscontrole met het bureaublad", async (t) => {
  const ui = browser(t);
  await import("../public/js/site-chrome.js?cpu-public-chrome-test");
  await settle();
  assert.deepEqual(
    ui.intervals.map((item) => item.delay),
    [60000, 60000],
  );
  assert.equal(ui.count("/api/creator"), 1);
  assert.equal(ui.count("/api/site-status"), 1);
  assert.ok(ui.requests.every(({ options }) => options.cache !== "no-store"));
  ui.document.dispatchEvent(new ui.window.Event("visibilitychange"));
  await settle();
  assert.equal(
    ui.count("/api/site-status"),
    1,
    "Quick tab switching does not start an extra request",
  );
  ui.hidden(true);
  ui.advance(60000);
  for (const { callback } of ui.intervals) await callback();
  assert.equal(ui.count("/api/site-status"), 1);
  ui.hidden(false);
  ui.document.dispatchEvent(new ui.window.Event("visibilitychange"));
  await settle();
  assert.equal(ui.count("/api/site-status"), 2);
  ui.maintenance(true);
  ui.window.addEventListener("amrp-maintenance-state", (event) =>
    event.preventDefault(),
  );
  ui.advance(60000);
  for (const { callback } of ui.intervals) await callback();
  assert.equal(ui.count("/api/site-status"), 3);
  assert.equal(
    ui.count("/api/me"),
    0,
    "The desktop's session check is reused during maintenance",
  );
});
