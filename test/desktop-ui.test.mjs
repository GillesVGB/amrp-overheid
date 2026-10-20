import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseHTML } from "linkedom";
import { createWindows } from "../public/js/windows.js";

function browser(t, html) {
  const { window } = parseHTML(html),
    memory = new Map(),
    assigned = [];
  const values = {
    window,
    document: window.document,
    location: {
      origin: "https://overheid.test",
      search: "",
      assign: (url) => assigned.push(url),
      replace: (url) => assigned.push(url),
    },
    history: { replaceState() {} },
    navigator: { onLine: true },
    localStorage: {
      getItem: (key) => memory.get(key) || null,
      setItem: (key, value) => memory.set(key, value),
    },
    innerWidth: 1280,
    innerHeight: 850,
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
  t.after(() => {
    for (const [key, descriptor] of originals)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
  });
  return {
    window,
    document: window.document,
    assigned,
    click: (element) =>
      element.dispatchEvent(new window.Event("click", { bubbles: true })),
    message(data, source, origin = "https://overheid.test") {
      const event = new window.Event("message");
      Object.assign(event, { data, source, origin });
      window.dispatchEvent(event);
    },
  };
}

test("Aanmeldscherm gebruikt Discord, toont Amsterdam wifi en sluit met een veilige terugkeeroptie", async (t) => {
  const ui = browser(
    t,
    fs.readFileSync(new URL("../public/login.html", import.meta.url), "utf8"),
  );
  const oldFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url === "/api/health")
      return Response.json({ discordConfigured: true, demo: false });
    if (url === "/api/me")
      return Response.json({ error: "Aanmelden vereist" }, { status: 401 });
    return Response.json({
      oauthUrl: "https://discord.com/oauth2/authorize?state=test",
    });
  };
  t.after(() => {
    globalThis.fetch = oldFetch;
  });
  let closed = 0;
  ui.window.close = () => closed++;
  await import("../public/js/login.js?ui-test");
  const get = (id) => ui.document.getElementById(id);
  assert.equal(get("login-form").querySelectorAll("input").length, 0);
  assert.equal(get("demo-login").hidden, true);
  assert.equal(get("discord-signin").disabled, false);
  ui.click(get("login-network"));
  assert.equal(get("login-wifi-menu").hidden, false);
  assert.match(get("login-wifi-menu").textContent, /Amsterdam wifi/);
  ui.click(get("login-power"));
  assert.equal(get("login-wifi-menu").hidden, true);
  assert.equal(get("login-power-menu").hidden, false);
  ui.click(get("login-close"));
  assert.equal(closed, 1);
  assert.equal(get("login-closed").hidden, false);
  assert.equal(get("login").hidden, true);
  ui.click(get("login-return"));
  assert.equal(get("login").hidden, false);
  get("login-form").dispatchEvent(
    new ui.window.Event("submit", { bubbles: true, cancelable: true }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  const login = calls.find((x) => x.url === "/auth/discord/login");
  assert.ok(login);
  assert.equal(login.options.method, "POST");
  assert.ok(!login.options.body.includes("password"));
  assert.match(ui.assigned[0], /^https:\/\/discord.com\//);
  assert.equal(
    ui.document.querySelector(".login-meos").getAttribute("href"),
    "https://meos.amsterdamrp.nl/",
  );
});

test("Aparte appvensters blijven bestaan bij wisselen, minimaliseren, maximaliseren en dupliceren", (t) => {
  const ui = browser(t, '<html><body><main id="desktop"></main></body></html>');
  let logout = 0;
  const focused = [];
  const manager = createWindows({
    host: ui.document.getElementById("desktop"),
    onFocus: (id) => focused.push(id),
    onLogout: () => logout++,
    toast: () => {},
  });
  const files = { id: "files", label: "Verkenner", icon: "folder" },
    training = { id: "training", label: "Opleidingen", icon: "badge" };
  assert.equal(ui.document.querySelectorAll(".managed-window").length, 0);
  manager.open(files);
  manager.open(training);
  const first = ui.document.querySelector(".managed-window"),
    frame = first.querySelector("iframe");
  frame.setAttribute("data-kept-form", "draft");
  manager.open(files);
  assert.equal(ui.document.querySelectorAll(".managed-window").length, 2);
  assert.equal(first.querySelector("iframe"), frame);
  assert.equal(frame.getAttribute("data-kept-form"), "draft");
  ui.click(first.querySelector('[aria-label="Venster maximaliseren"]'));
  assert.ok(first.classList.contains("is-maximized"));
  ui.click(first.querySelector('[aria-label="Venster herstellen"]'));
  assert.ok(!first.classList.contains("is-maximized"));
  ui.click(first.querySelector('[aria-label="Nieuw venster"]'));
  assert.equal(manager.count("files"), 2);
  assert.equal(ui.document.querySelectorAll("iframe").length, 3);
  const duplicate = ui.document.querySelectorAll(".managed-window")[2];
  ui.click(duplicate.querySelector('[aria-label="Venster sluiten"]'));
  assert.equal(manager.count("files"), 1);
  ui.click(first.querySelector('[aria-label="Minimaliseren"]'));
  assert.equal(first.hidden, true);
  manager.open(files);
  assert.equal(first.hidden, false);
  ui.message({ type: "amrp-logout" }, {}, "https://evil.test");
  assert.equal(logout, 0);
  const received = [],
    source = { postMessage: (message) => received.push(message) };
  Object.defineProperty(frame, "contentWindow", { value: source });
  ui.message({ type: "amrp-ready" }, source);
  ui.message({ type: "amrp-logout" }, source);
  assert.equal(logout, 1);
  manager.open(files, { navigate: { action: "files", id: "test-doc" } });
  assert.ok(
    received.some(
      (x) => x.type === "amrp-navigate" && x.result.id === "test-doc",
    ),
  );
  assert.equal(focused.at(-1), "files");
});

test("Na aanmelden blijft het bureaublad leeg totdat een afzonderlijke app wordt geopend", async (t) => {
  const ui = browser(
    t,
    fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8"),
  );
  const descriptors = new Map(
    ["parent", "setInterval", "fetch"].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  Object.defineProperty(globalThis, "parent", {
    value: ui.window,
    writable: true,
    configurable: true,
  });
  globalThis.setInterval = () => 0;
  globalThis.fetch = async (url) =>
    Response.json(
      url === "/api/preferences"
        ? { wallpaper: "bloom" }
        : {
            user: {
              id: "test",
              username: "test",
              mustChange: false,
              discordId: "990000000000000001",
            },
            permissions: {
              owner: true,
              admin: true,
              policeRead: true,
              policeWrite: true,
              ambulance: true,
            },
            discordName: "Test",
            settings: { name: "Amsterdam" },
            authMode: "discord",
          },
    );
  const priorRect = ui.window.HTMLElement.prototype.getBoundingClientRect;
  ui.window.HTMLElement.prototype.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    width: 1280,
    height: 800,
  });
  t.after(() => {
    for (const [key, descriptor] of descriptors)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    ui.window.HTMLElement.prototype.getBoundingClientRect = priorRect;
  });
  await import("../public/js/desktop.js?empty-desktop-test");
  assert.equal(ui.document.querySelectorAll(".managed-window").length, 0);
  assert.equal(ui.document.getElementById("app-window").hidden, true);
  for (const app of ["files", "training", "requests"]) {
    const shortcut = ui.document.querySelector(
      '#pinned-apps [data-app="' + app + '"]',
    );
    assert.ok(shortcut);
    ui.click(shortcut);
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(ui.document.querySelectorAll(".managed-window").length, 3);
  const sources = [
    ...ui.document.querySelectorAll(".managed-window iframe"),
  ].map((frame) => frame.src);
  assert.ok(sources.some((src) => src.includes("app=files")));
  assert.ok(sources.some((src) => src.includes("app=training")));
  assert.ok(sources.some((src) => src.includes("app=requests")));
  assert.ok(
    ui.document.querySelector('link[rel="icon"][href^="/favicon.svg"]'),
  );
});
