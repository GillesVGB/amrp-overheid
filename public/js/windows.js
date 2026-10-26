import { icon } from "./icons.js";

// Each app keeps its own document and forms while other windows are being used.
export function createWindows({
  host,
  onFocus = () => {},
  onLogout = () => {},
  onAppearance = () => {},
  getAppearance = () => ({ wallpaper: "bloom", theme: "light" }),
  getSession = () => null,
  onSearch = () => {},
  onOpen = () => {},
  toast,
}) {
  const layer = document.createElement("div");
  layer.className = "managed-windows";
  host.append(layer);
  const windows = new Map();
  let counter = 0,
    front = null,
    revision = null;
  const post = (entry, message) =>
    entry.frame.contentWindow?.postMessage(message, location.origin);
  function focus(entry) {
    if (!entry || !windows.has(entry.id)) return;
    front = entry;
    entry.element.hidden = false;
    const order = [...windows.values()]
      .filter((x) => x !== entry)
      .sort(
        (a, b) =>
          Number(a.element.style.zIndex) - Number(b.element.style.zIndex),
      );
    [...order, entry].forEach((item, index) => {
      item.element.style.zIndex = String(index + 1);
      item.element.classList.toggle("is-focused", item === entry);
    });
    post(entry, { type: "amrp-visibility", visible: true });
    onFocus(entry.app.id);
  }
  function notifyFront() {
    const visible = [...windows.values()]
      .filter((x) => !x.element.hidden)
      .sort(
        (a, b) =>
          Number(b.element.style.zIndex) - Number(a.element.style.zIndex),
      );
    front = visible[0] || null;
    if (front) focus(front);
    else onFocus(null);
  }
  function remove(entry) {
    if (!windows.has(entry.id)) return;
    windows.delete(entry.id);
    entry.element.remove();
    notifyFront();
  }
  function close(entry) {
    if (!entry.ready) return remove(entry);
    post(entry, { type: "amrp-close" });
    setTimeout(() => remove(entry), 700);
  }
  function maximize(entry) {
    entry.element.classList.toggle("is-maximized");
    entry.maximize.setAttribute(
      "aria-label",
      entry.element.classList.contains("is-maximized")
        ? "Venster herstellen"
        : "Venster maximaliseren",
    );
  }
  function minimize(entry) {
    entry.element.hidden = true;
    post(entry, { type: "amrp-visibility", visible: false });
    notifyFront();
  }
  function open(app, { fresh = false, navigate = null } = {}) {
    let entry = fresh
      ? null
      : [...windows.values()].reverse().find((x) => x.app.id === app.id);
    if (entry) {
      focus(entry);
      if (navigate) {
        entry.pending = navigate;
        if (entry.ready)
          post(entry, { type: "amrp-navigate", result: navigate });
      }
      return;
    }
    if (windows.size >= 10) {
      toast("Er staan al tien vensters open. Sluit eerst een venster.", true);
      return;
    }
    const element = document.createElement("section");
    element.className = "managed-window";
    element.setAttribute("aria-label", app.label + " — applicatievenster");
    const offset = (counter++ % 6) * 27;
    element.style.cssText = `left:${Math.min(100 + offset, innerWidth * 0.15)}px;top:${24 + offset}px;width:${Math.min(innerWidth - 40, 1100)}px;height:${Math.min(innerHeight - 115, 740)}px`;
    const bar = document.createElement("header");
    bar.className = "managed-titlebar";
    const title = document.createElement("span");
    title.innerHTML = icon(app.icon);
    const label = document.createElement("span");
    label.textContent = app.label;
    title.append(label);
    bar.append(title);
    const controls = document.createElement("div");
    controls.className = "managed-controls";
    const button = (text, label, handler) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = text;
      b.title = label;
      b.setAttribute("aria-label", label);
      b.addEventListener("click", handler);
      controls.append(b);
      return b;
    };
    button("+", "Nieuw venster", () => open(app, { fresh: true }));
    button("−", "Minimaliseren", () => minimize(entry));
    const max = button("□", "Venster maximaliseren", () => maximize(entry));
    button("×", "Venster sluiten", () => close(entry));
    bar.append(controls);
    element.append(bar);
    const frame = document.createElement("iframe");
    frame.title = app.label + " — overheidswerkplek";
    frame.src = "/?window=1&app=" + encodeURIComponent(app.id);
    frame.referrerPolicy = "same-origin";
    element.append(frame);
    entry = {
      id: counter,
      app,
      element,
      frame,
      maximize: max,
      ready: false,
      pending: navigate,
    };
    windows.set(entry.id, entry);
    layer.append(element);
    element.addEventListener("pointerdown", () => {
      if (front !== entry) focus(entry);
    });
    bar.addEventListener("dblclick", (event) => {
      if (!event.target.closest("button")) maximize(entry);
    });
    bar.addEventListener("pointerdown", (event) => {
      if (
        event.button !== 0 ||
        event.target.closest("button") ||
        element.classList.contains("is-maximized") ||
        innerWidth < 760
      )
        return;
      focus(entry);
      const start = element.getBoundingClientRect(),
        x = event.clientX,
        y = event.clientY;
      bar.setPointerCapture(event.pointerId);
      element.classList.add("is-dragging");
      const move = (ev) => {
        element.style.left =
          Math.max(0, Math.min(innerWidth - 120, start.left + ev.clientX - x)) +
          "px";
        element.style.top =
          Math.max(0, Math.min(innerHeight - 95, start.top + ev.clientY - y)) +
          "px";
      };
      const end = () => {
        element.classList.remove("is-dragging");
        bar.removeEventListener("pointermove", move);
        bar.removeEventListener("pointerup", end);
        bar.removeEventListener("pointercancel", end);
      };
      bar.addEventListener("pointermove", move);
      bar.addEventListener("pointerup", end);
      bar.addEventListener("pointercancel", end);
    });
    focus(entry);
  }
  function receive(event) {
    if (event.origin !== location.origin) return;
    const entry = [...windows.values()].find(
      (x) => x.frame.contentWindow === event.source,
    );
    if (!entry) return;
    const message = event.data;
    if (!message || typeof message !== "object") return;
    if (message.type === "amrp-ready") {
      entry.ready = true;
      post(entry, { type: "amrp-appearance", appearance: getAppearance() });
      post(entry, { type: "amrp-visibility", visible: !entry.element.hidden });
      const session = getSession();
      if (session) post(entry, { type: "amrp-session", session });
      if (revision !== null) post(entry, { type: "amrp-changes", revision });
      if (entry.pending)
        post(entry, { type: "amrp-navigate", result: entry.pending });
    }
    if (message.type === "amrp-focus" && front !== entry) focus(entry);
    if (message.type === "amrp-closed") remove(entry);
    if (message.type === "amrp-logout") onLogout(message.message);
    if (message.type === "amrp-appearance" && message.appearance)
      onAppearance(message.appearance);
    if (message.type === "amrp-search") onSearch();
    if (message.type === "amrp-open" && typeof message.appId === "string")
      onOpen(message.appId);
    if (
      message.type === "amrp-window-title" &&
      typeof message.title === "string"
    )
      labelTitle(entry, message.title);
  }
  function labelTitle(entry, title) {
    entry.element.querySelector(".managed-titlebar>span>span").textContent =
      title.slice(0, 100);
  }
  window.addEventListener("message", receive);
  window.addEventListener("resize", () => {
    for (const entry of windows.values()) {
      const rect = entry.element.getBoundingClientRect();
      if (rect.left > innerWidth - 100)
        entry.element.style.left = Math.max(0, innerWidth - 150) + "px";
      if (rect.top > innerHeight - 100) entry.element.style.top = "20px";
    }
  });
  return {
    open,
    broadcastAppearance(appearance) {
      for (const entry of windows.values())
        if (entry.ready) post(entry, { type: "amrp-appearance", appearance });
    },
    broadcastSession(session) {
      for (const entry of windows.values())
        if (entry.ready) post(entry, { type: "amrp-session", session });
    },
    broadcastChanges(value) {
      revision = value;
      for (const entry of windows.values())
        if (entry.ready) post(entry, { type: "amrp-changes", revision });
    },
    count(appId) {
      return [...windows.values()].filter((x) => x.app.id === appId).length;
    },
    prune(allowed) {
      for (const entry of windows.values())
        if (!allowed.includes(entry.app.id)) close(entry);
    },
    navigate(app, result) {
      open(app, { navigate: result });
    },
  };
}
