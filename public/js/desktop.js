import { icon } from "./icons.js";
import { createPortal, escapeHtml as e } from "./politie.js";
import { createApi } from "./api.js";
import { createAmbulance } from "./ambulance.js";
import { createWorkspace } from "./workspace.js";
const $ = (id) => document.getElementById(id);
let me = null,
  portal = null,
  workspace = null,
  ambulance = null,
  currentApp = null,
  toastTimer,
  currentWallpaper = "bloom";
const wallpaperOptions = [
  {
    id: "bloom",
    label: "Windows 11 Bloom",
    detail: "Blauwe standaardachtergrond",
  },
  {
    id: "classic",
    label: "Windows klassiek",
    detail: "Lichtblauwe Windows-achtergrond",
  },
  {
    id: "midnight",
    label: "Middernacht",
    detail: "Donkere achtergrond met blauwe gloed",
  },
  {
    id: "amsterdam",
    label: "Amsterdam",
    detail: "Stedelijk blauw kleurverloop",
  },
];
function setWallpaper(value) {
  if (!wallpaperOptions.some((option) => option.id === value)) value = "bloom";
  currentWallpaper = value;
  document.querySelectorAll(".wallpaper").forEach((element) => {
    element.dataset.wallpaper = value;
  });
  try {
    localStorage.setItem("amrp-wallpaper", value);
  } catch {
    // The server preference remains the source of truth.
  }
}
const desktopPositionKey = "amrp-desktop-shortcuts-v1";
function readDesktopPositions() {
  try {
    return JSON.parse(localStorage.getItem(desktopPositionKey) || "{}");
  } catch {
    return {};
  }
}
function writeDesktopPositions() {
  try {
    const positions = Object.fromEntries(
      [...document.querySelectorAll(".desktop-icon[data-app]")].map((item) => [
        item.dataset.app,
        {
          x: parseInt(item.style.left, 10) || 0,
          y: parseInt(item.style.top, 10) || 0,
        },
      ]),
    );
    localStorage.setItem(desktopPositionKey, JSON.stringify(positions));
  } catch {
    // Keep the desktop usable when browser storage is unavailable.
  }
}
function positionDesktopIcons() {
  const area = $("desktop-icons"),
    saved = readDesktopPositions();
  [...area.querySelectorAll(".desktop-icon[data-app]")].forEach(
    (item, index) => {
      const rect = area.getBoundingClientRect(),
        rows = Math.max(1, Math.floor((rect.height - 18) / 104)),
        pos = saved[item.dataset.app] || {
          x: 18 + Math.floor(index / rows) * 104,
          y: 18 + (index % rows) * 104,
        },
        maxX = Math.max(0, rect.width - item.offsetWidth),
        maxY = Math.max(0, rect.height - item.offsetHeight);
      item.style.left = Math.max(0, Math.min(maxX, Number(pos.x) || 0)) + "px";
      item.style.top = Math.max(0, Math.min(maxY, Number(pos.y) || 0)) + "px";
    },
  );
}
export function toast(message, error = false) {
  clearTimeout(toastTimer);
  $("toast").textContent = message;
  $("toast").classList.toggle("error", error);
  $("toast").hidden = false;
  toastTimer = setTimeout(() => ($("toast").hidden = true), 5000);
}
const api = createApi({
  getSession: () => me,
  onUnauthorized: (message) => lockScreen(message),
});
function fillIcons(root = document) {
  root
    .querySelectorAll("[data-icon]")
    .forEach((el) => (el.innerHTML = icon(el.dataset.icon)));
}
function initials(name) {
  return name
    .split(/[ ._-]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((x) => x[0])
    .join("")
    .toUpperCase();
}
function apps() {
  return [
    { id: "pc", label: "Deze pc", icon: "pc", className: "", access: true },
    {
      id: "personal",
      label: "Persoonlijke instellingen",
      icon: "settings",
      className: "admin",
      access: true,
    },
    {
      id: "police",
      label: "Politie",
      icon: "shield",
      className: "police",
      access:
        me.permissions.policeRead ||
        me.permissions.archive ||
        me.permissions.audit,
    },
    {
      id: "admin",
      label: "Systeembeheer",
      icon: "settings",
      className: "admin",
      access: me.permissions.admin,
    },
    {
      id: "ambulance",
      label: "Ambulance",
      icon: "ambulance",
      className: "ambulance",
      access: me.permissions.ambulance,
    },
    {
      id: "files",
      label: "Verkenner",
      icon: "folder",
      className: "files",
      access: true,
    },
    {
      id: "training",
      label: "Opleidingen",
      icon: "badge",
      className: "training",
      access: true,
    },
    {
      id: "requests",
      label: "Aanvragen",
      icon: "file",
      className: "requests",
      access: true,
    },
  ].filter((x) => x.access);
}
function homeApp() {
  return me.permissions.owner
    ? "admin"
    : me.permissions.policeRead
      ? "police"
      : me.permissions.ambulance
        ? "ambulance"
        : me.permissions.admin
          ? "admin"
          : "pc";
}
function renderDesktop() {
  const items = apps();
  $("desktop-icons").innerHTML = items
    .map(
      (a) =>
        `<button class="desktop-icon" data-app="${a.id}" title="Dubbelklik om te openen"><span class="app-symbol ${a.className}">${icon(a.icon)}</span><span>${a.label}</span></button>`,
    )
    .join("");
  positionDesktopIcons();
  $("pinned-apps").innerHTML = items
    .map(
      (a) =>
        `<button title="${a.label}" aria-label="${a.label}" data-app="${a.id}" ${currentApp === a.id ? 'class="active"' : ""}>${icon(a.icon)}</button>`,
    )
    .join("");
  $("environment-name").textContent = me.settings.name;
  $("quick-settings-name").textContent = me.settings.name;
  $("desktop-session").innerHTML =
    `${e(me.discordName)}<small>${me.permissions.owner ? "Eigenaar" : me.permissions.admin ? "Overheidsbeheerder" : me.permissions.policeWrite ? "Korpsleiding" : me.permissions.policeRead ? "Politieagent" : me.permissions.ambulance ? "Ambulancedienst" : "Medewerker"}</small>`;
  $("demo-banner").hidden = !me.demo;
}
let searchTimer,
  searchVersion = 0,
  searchResults = [];
async function searchWorkspace(query) {
  const version = ++searchVersion;
  clearTimeout(searchTimer);
  const target = $("work-search-results");
  if (!target) return;
  searchResults = [];
  if (query.trim().length < 2) {
    target.textContent =
      "Zoek ook naar medewerkers, roepnummers en documenten.";
    return;
  }
  target.textContent = "Zoeken…";
  searchTimer = setTimeout(async () => {
    try {
      const { results } = await api(
        "/api/search?q=" + encodeURIComponent(query.trim().slice(0, 100)),
      );
      if (version !== searchVersion || !target.isConnected) return;
      searchResults = results;
      const labels = {
        personnel: "Medewerker",
        callsign: "Roepnummer",
        archive: "Archief",
        document: "Document",
        course: "Opleiding",
      };
      target.innerHTML = results.length
        ? results
            .map(
              (r, index) =>
                `<button class="work-search-result" data-search-result="${index}">${icon(r.type === "personnel" ? "users" : r.type === "callsign" ? "table" : "file")}<span><strong>${e(r.title)}</strong><small>${e(labels[r.type] || "Werkplek")} · ${e(r.subtitle)}</small></span>${icon("chevron")}</button>`,
            )
            .join("")
        : "Geen resultaten binnen jouw toegangsrechten.";
    } catch (error) {
      if (version === searchVersion && target.isConnected)
        target.textContent = error.message;
    }
  }, 350);
}
function startMenu(query = "") {
  const filtered = apps().filter((x) =>
    x.label.toLowerCase().includes(query.toLowerCase()),
  );
  $("start-menu").innerHTML =
    `<div class="start-search">${icon("search")}<input id="start-search-input" type="search" value="${e(query)}" placeholder="Apps, medewerkers en documenten zoeken" aria-label="Zoeken op je werkplek" maxlength="100"></div><div class="start-section-heading"><strong>Vastgemaakt</strong><span>${filtered.length} apps</span></div><div class="start-app-grid">${filtered.map((a) => `<button data-app="${a.id}"><span class="app-symbol ${a.className}">${icon(a.icon)}</span><span>${a.label}</span></button>`).join("")}</div><div class="start-section-heading"><strong>Werkplek doorzoeken</strong><span>Alleen jouw afdelingen</span></div><div id="work-search-results" class="work-search-results" aria-live="polite"></div><footer class="start-footer"><button data-action="my-password"><span class="user-initials">${e(initials(me.discordName))}</span>${e(me.discordName)}</button><button data-action="logout" title="Afmelden" aria-label="Afmelden">${icon("power")}</button></footer>`;
  searchWorkspace(query);
  $("start-search-input").addEventListener("input", (event) => {
    const value = event.target.value;
    searchWorkspace(value);
    const grid = $("start-menu").querySelector(".start-app-grid");
    grid.innerHTML = apps()
      .filter((x) => x.label.toLowerCase().includes(value.toLowerCase()))
      .map(
        (a) =>
          `<button data-app="${a.id}"><span class="app-symbol ${a.className}">${icon(a.icon)}</span><span>${a.label}</span></button>`,
      )
      .join("");
  });
}
function toggleStart(force) {
  const show = force ?? $("start-menu").hidden;
  $("start-menu").hidden = !show;
  $("start-button").setAttribute("aria-expanded", String(show));
  if (show) startMenu($("desktop-search").value);
}
async function launch(appId) {
  const a = apps().find((x) => x.id === appId);
  if (!a) return;
  portal?.destroy?.();
  portal = null;
  workspace?.destroy();
  workspace = null;
  ambulance?.destroy?.();
  ambulance = null;
  $("app-body").onclick = null;
  $("app-body").oninput = null;
  $("app-body").onchange = null;
  $("app-body").onsubmit = null;
  if ($("dialog").open && !me.user.mustChange) $("dialog").close();
  currentApp = appId;
  toggleStart(false);
  $("app-window").hidden = false;
  $("window-title").innerHTML =
    icon(a.icon) + e(a.label) + " — " + e(me.settings.name);
  renderDesktop();
  if (["files", "training", "requests"].includes(appId)) {
    workspace = createWorkspace({ api, me, toast, onChange: () => {} });
    await workspace.render($("app-body"), appId);
    return;
  }
  if (appId === "pc") {
    $("app-body").innerHTML =
      `<div class="explorer"><span class="eyebrow">BEVEILIGDE WERKPLEK</span><h1>Deze pc</h1><p>Welkom, ${e(me.discordName)}. Open een applicatie om aan de slag te gaan.<br>De beschikbare applicaties volgen je actuele rollen in de overheids-Discord.</p><div class="explorer-apps">${apps()
        .filter((x) => x.id !== "pc")
        .map(
          (x) =>
            `<button data-app="${x.id}"><span class="app-symbol ${x.className}">${icon(x.icon)}</span><span><strong>${x.label}</strong><small>Applicatie openen</small></span></button>`,
        )
        .join(
          "",
        )}</div><div class="security-note">${icon("lock")} Personeelsgegevens en bestanden worden gedeeld opgeslagen. Je persoonlijke sessie wordt na 30 minuten inactiviteit beëindigd.</div><dl class="help-list"><dt>Mijn account</dt><dd>${e(me.user.username)} · Discord-ID ${e(me.user.discordId)}</dd><dt>Verbinding</dt><dd>${me.demo ? "Afgeschermde lokale demonstratie" : "Discord OAuth2 · rollen gecontroleerd op de server"}</dd></dl></div>`;
    return;
  }
  if (appId === "personal") {
    const saved = currentWallpaper;
    $("app-body").innerHTML =
      `<div class="explorer"><span class="eyebrow">JOUW WERKPLEK</span><h1>Persoonlijke instellingen</h1><p>Kies een achtergrond voor jouw overheidswerkplek. Je keuze wordt aan jouw account gekoppeld en is ook zichtbaar op andere apparaten.</p><section class="wallpaper-choices">${wallpaperOptions.map((option) => `<button class="wallpaper-choice ${saved === option.id ? "selected" : ""}" data-wallpaper="${option.id}"><span class="wallpaper-preview wallpaper-${option.id}"></span><strong>${e(option.label)}</strong><small>${e(option.detail)}</small><span class="wallpaper-check">${saved === option.id ? icon("check") : ""}</span></button>`).join("")}</section></div>`;
    return;
  }
  if (appId === "ambulance") {
    ambulance = createAmbulance({ api, me, toast });
    await ambulance.open();
    return;
  }
  try {
    portal = createPortal({
      api,
      me,
      toast,
      section: appId === "admin" ? "admin" : "police",
      onSettings: async () => {
        me = await api("/api/me");
        renderDesktop();
      },
    });
    const initialTab =
      appId === "admin"
        ? me.permissions.owner
          ? "owner"
          : "settings"
        : me.permissions.policeRead
          ? "dutyboard"
          : me.permissions.audit
            ? "audit"
            : "archive";
    await portal.open(initialTab);
  } catch (err) {
    toast(err.message, true);
  }
}
function lockScreen(message) {
  me = null;
  location.replace(
    "/login.html?melding=" + encodeURIComponent(message || "Meld opnieuw aan."),
  );
}
async function enter() {
  $("loading").hidden = false;
  const start = Date.now();
  if (me.user.mustChange) {
    $("loading").hidden = true;
    $("desktop").hidden = false;
    renderDesktop();
    passwordDialog(true);
    return;
  }
  await new Promise((resolve) =>
    setTimeout(resolve, Math.max(0, 2000 - (Date.now() - start))),
  );
  $("loading").hidden = true;
  $("desktop").hidden = false;
  renderDesktop();
  await launch(homeApp());
}
function passwordDialog(required = false) {
  $("modal-title").textContent = required
    ? "Stel je eigen wachtwoord in"
    : "Wachtwoord wijzigen";
  $("modal-body").innerHTML =
    `${required ? '<div class="security-note">Stel je persoonlijke wachtwoord in om je account te activeren.</div>' : '<label class="field">Huidig wachtwoord<input type="password" name="currentPassword" autocomplete="current-password" required maxlength="128"></label>'}<label class="field">Nieuw wachtwoord<input type="password" name="newPassword" autocomplete="new-password" minlength="12" maxlength="128" required><small>Minimaal 12 tekens. Andere sessies worden afgemeld.</small></label><label class="field">Nieuw wachtwoord herhalen<input type="password" name="confirmPassword" autocomplete="new-password" minlength="12" maxlength="128" required></label>`;
  $("modal-error").textContent = "";
  $("modal-save").hidden = false;
  $("modal-save").textContent = "Wachtwoord opslaan";
  $("dialog").showModal();
  const closeButtons = $("dialog").querySelectorAll(
    '[data-action="close-modal"]',
  );
  closeButtons.forEach((x) => (x.hidden = required));
  $("dialog").oncancel = required ? (ev) => ev.preventDefault() : null;
  $("modal-form").onsubmit = async (ev) => {
    ev.preventDefault();
    const values = Object.fromEntries(new FormData(ev.target));
    if (values.newPassword !== values.confirmPassword) {
      $("modal-error").textContent =
        "De nieuwe wachtwoorden komen niet overeen.";
      return;
    }
    $("modal-save").disabled = true;
    try {
      await api("/api/password", { method: "POST", body: values });
      me = await api("/api/me");
      $("dialog").close();
      closeButtons.forEach((x) => (x.hidden = false));
      toast("Je wachtwoord is gewijzigd.");
      if (required) await enter();
    } catch (error) {
      $("modal-error").textContent = error.message;
    } finally {
      $("modal-save").disabled = false;
    }
  };
}
$("start-button").addEventListener("click", () => toggleStart());
$("desktop-search").addEventListener("input", () => {
  toggleStart(true);
  startMenu($("desktop-search").value);
});
document.addEventListener("click", async (ev) => {
  const target = ev.target.closest("button,a");
  if (!target) return;
  if (target.dataset.searchResult !== undefined) {
    const result = searchResults[Number(target.dataset.searchResult)];
    if (!result) return;
    try {
      if (result.action === "files") {
        await launch("files");
        await workspace.openDocument(result.id);
      } else if (result.action === "training") await launch("training");
      else {
        await launch("police");
        await portal?.navigateSearch(result);
      }
    } catch (error) {
      toast(error.message, true);
    }
    return;
  }
  if (Number(target.dataset.draggedUntil) > performance.now()) {
    ev.preventDefault();
    return;
  }
  if (target.dataset.app) {
    if (target.classList.contains("desktop-icon")) {
      document
        .querySelectorAll(".desktop-icon")
        .forEach((x) => x.classList.toggle("selected", x === target));
      if (ev.detail < 2 && !matchMedia("(pointer: coarse)").matches) return;
    }
    await launch(target.dataset.app);
    return;
  }
  if (target.dataset.wallpaper) {
    try {
      const result = await api("/api/preferences", {
        method: "PUT",
        body: { wallpaper: target.dataset.wallpaper },
      });
      setWallpaper(result.wallpaper);
      target
        .closest(".wallpaper-choices")
        .querySelectorAll(".wallpaper-choice")
        .forEach((item) => {
          item.classList.toggle("selected", item === target);
          item.querySelector(".wallpaper-check").innerHTML =
            item === target ? icon("check") : "";
        });
      toast("Je achtergrond is bijgewerkt.");
    } catch (error) {
      toast(error.message, true);
    }
    return;
  }
  const action = target.dataset.action;
  if (action === "close-window") {
    portal?.destroy?.();
    portal = null;
    workspace?.destroy();
    workspace = null;
    ambulance?.destroy?.();
    ambulance = null;
    $("app-window").hidden = true;
    currentApp = null;
    renderDesktop();
  }
  if (action === "minimize") $("app-window").hidden = true;
  if (action === "maximize") $("app-window").classList.toggle("maximized");
  if (action === "close-modal") $("dialog").close();
  if (action === "my-password") passwordDialog();
  if (action === "logout") {
    try {
      await api("/auth/logout", { method: "POST", body: {} });
      lockScreen("Je bent veilig afgemeld.");
    } catch (error) {
      toast(error.message, true);
    }
  }
});
let iconDrag = null;
$("desktop-icons").addEventListener("pointerdown", (ev) => {
  const target = ev.target.closest(".desktop-icon[data-app]");
  if (!target || ev.button !== 0) return;
  const area = $("desktop-icons").getBoundingClientRect();
  iconDrag = {
    target,
    pointerId: ev.pointerId,
    startX: ev.clientX,
    startY: ev.clientY,
    left: parseInt(target.style.left, 10) || 0,
    top: parseInt(target.style.top, 10) || 0,
    area,
    moved: false,
  };
  target.setPointerCapture(ev.pointerId);
});
$("desktop-icons").addEventListener("pointermove", (ev) => {
  if (!iconDrag || iconDrag.pointerId !== ev.pointerId) return;
  const dx = ev.clientX - iconDrag.startX,
    dy = ev.clientY - iconDrag.startY;
  if (!iconDrag.moved && Math.hypot(dx, dy) < 5) return;
  iconDrag.moved = true;
  iconDrag.target.classList.add("dragging");
  ev.preventDefault();
  const maxX = Math.max(0, iconDrag.area.width - iconDrag.target.offsetWidth),
    maxY = Math.max(0, iconDrag.area.height - iconDrag.target.offsetHeight);
  iconDrag.target.style.left =
    Math.max(0, Math.min(maxX, iconDrag.left + dx)) + "px";
  iconDrag.target.style.top =
    Math.max(0, Math.min(maxY, iconDrag.top + dy)) + "px";
});
function finishIconDrag(ev) {
  if (!iconDrag || iconDrag.pointerId !== ev.pointerId) return;
  const { target, moved } = iconDrag;
  iconDrag = null;
  target.classList.remove("dragging");
  if (moved) {
    target.dataset.draggedUntil = String(performance.now() + 250);
    writeDesktopPositions();
    setTimeout(() => delete target.dataset.draggedUntil, 300);
  }
}
$("desktop-icons").addEventListener("pointerup", finishIconDrag);
$("desktop-icons").addEventListener("pointercancel", finishIconDrag);
window.addEventListener("resize", positionDesktopIcons);
document.addEventListener("keydown", async (ev) => {
  const target = ev.target.closest(".desktop-icon[data-app]");
  if (target && (ev.key === "Enter" || ev.key === " ")) {
    ev.preventDefault();
    await launch(target.dataset.app);
  }
});
document.addEventListener("pointerdown", (ev) => {
  if (
    !$("start-menu").hidden &&
    !ev.target.closest("#start-menu,#start-button,#desktop-search")
  )
    toggleStart(false);
});
$("window-titlebar").addEventListener("dblclick", (ev) => {
  if (!ev.target.closest("button"))
    $("app-window").classList.toggle("maximized");
});
$("window-titlebar").addEventListener("pointerdown", (ev) => {
  if (
    ev.target.closest("button") ||
    innerWidth <= 760 ||
    $("app-window").classList.contains("maximized")
  )
    return;
  const el = $("app-window"),
    rect = el.getBoundingClientRect(),
    x = ev.clientX,
    y = ev.clientY;
  ev.currentTarget.setPointerCapture(ev.pointerId);
  const move = (event) => {
    el.style.left =
      Math.max(0, Math.min(innerWidth - 150, rect.left + event.clientX - x)) +
      "px";
    el.style.top =
      Math.max(0, Math.min(innerHeight - 100, rect.top + event.clientY - y)) +
      "px";
  };
  el.style.transform = "none";
  el.style.left = rect.left + "px";
  el.style.top = rect.top + "px";
  const finish = () => {
    $("window-titlebar").removeEventListener("pointermove", move);
    $("window-titlebar").removeEventListener("pointerup", finish);
  };
  $("window-titlebar").addEventListener("pointermove", move);
  $("window-titlebar").addEventListener("pointerup", finish, { once: true });
});
function clock() {
  const now = new Date();
  $("clock-time").textContent = now.toLocaleTimeString("nl-NL", {
    hour: "2-digit",
    minute: "2-digit",
  });
  $("clock-date").textContent = now.toLocaleDateString("nl-NL");
}
clock();
setInterval(clock, 1000);
$("clock-button").addEventListener("click", () =>
  toast(
    new Date().toLocaleString("nl-NL", {
      dateStyle: "full",
      timeStyle: "short",
    }),
  ),
);
$("notifications-button").addEventListener("click", () =>
  toast(
    "Je rechten worden op de server gecontroleerd. Wijzigingen worden direct gedeeld opgeslagen.",
  ),
);
$("quick-settings-button").addEventListener("click", () => {
  const panel = $("quick-settings"),
    open = panel.hidden;
  panel.hidden = !open;
  $("quick-settings-button").setAttribute("aria-expanded", String(open));
  $("network-state").textContent = navigator.onLine ? "Verbonden" : "Offline";
  $("network-detail").textContent = navigator.onLine
    ? "Internet beschikbaar"
    : "Geen internetverbinding";
});
document.addEventListener("click", (ev) => {
  if (
    !$("quick-settings").hidden &&
    !ev.target.closest("#quick-settings,#quick-settings-button")
  ) {
    $("quick-settings").hidden = true;
    $("quick-settings-button").setAttribute("aria-expanded", "false");
  }
});
window.addEventListener("online", () => {
  $("network-state").textContent = "Verbonden";
  $("network-detail").textContent = "Internet beschikbaar";
});
window.addEventListener("offline", () => {
  $("network-state").textContent = "Offline";
  $("network-detail").textContent = "Geen internetverbinding";
});
async function checkSession() {
  if (!me || document.hidden) return;
  try {
    const updated = await api("/api/me");
    if (
      JSON.stringify(updated.permissions) !== JSON.stringify(me.permissions)
    ) {
      me = updated;
      renderDesktop();
      await launch(homeApp());
      toast("Je toegangsrechten zijn bijgewerkt.");
    }
  } catch (error) {
    if ([401, 403].includes(error.status)) lockScreen(error.message);
    else
      toast(
        "Je rechten kunnen nu niet worden gecontroleerd. Heropen de applicatie zodra de verbinding terug is.",
        true,
      );
  }
}
setInterval(checkSession, 60000);
let sharedRevision = null,
  polling = false;
async function checkChanges() {
  if (!me || me.user.mustChange || document.hidden || polling) return;
  polling = true;
  try {
    const { revision } = await api("/api/changes");
    if (sharedRevision === null) {
      sharedRevision = revision;
      return;
    }
    if (revision !== sharedRevision) {
      if ($("dialog").open) return;
      let refreshed = true;
      if (workspace) refreshed = await workspace.refresh();
      else if (portal) refreshed = await portal.refresh();
      else if (ambulance) refreshed = await ambulance.refresh();
      if (refreshed !== false) sharedRevision = revision;
    }
    $("notifications-button").title =
      "Live verbonden · gecontroleerd " +
      new Date().toLocaleTimeString("nl-NL", {
        hour: "2-digit",
        minute: "2-digit",
      });
  } catch {
    $("notifications-button").title =
      "Live verbinding tijdelijk onderbroken; opnieuw verbinden…";
  } finally {
    polling = false;
  }
}
setInterval(checkChanges, 10000);
window.addEventListener("focus", checkChanges);
document.addEventListener("keydown", (event) => {
  if (
    event.ctrlKey &&
    event.key.toLowerCase() === "k" &&
    me &&
    !$("dialog").open
  ) {
    event.preventDefault();
    toggleStart(true);
    $("start-search-input").focus();
  }
});
window.addEventListener("focus", checkSession);
fillIcons();
try {
  me = await api("/api/me");
  const preference = await api("/api/preferences");
  setWallpaper(preference.wallpaper);
  await enter();
  await checkChanges();
} catch (error) {
  lockScreen(error.message);
}
