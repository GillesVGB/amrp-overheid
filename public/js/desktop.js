import { icon } from "./icons.js";
import { createPortal, escapeHtml as e } from "./politie.js";
import { createApi } from "./api.js";
import { createAmbulance } from "./ambulance.js";
import { createWorkspace } from "./workspace.js";
import { createWindows } from "./windows.js";
import {
  wallpaperOptions,
  themeOptions,
  applyAppearance,
  restoreAppearance,
} from "./appearance.js";
const $ = (id) => document.getElementById(id);
const embedded =
  parent !== window &&
  new URLSearchParams(location.search).get("window") === "1";
let windowManager = null,
  embeddedVisible = true;
if (embedded) document.body.classList.add("app-window-embedded");
let me = null,
  portal = null,
  workspace = null,
  ambulance = null,
  currentApp = null,
  toastTimer,
  currentAppearance = restoreAppearance(),
  savingAppearance = false;
function syncAppearanceChoices() {
  for (const field of ["wallpaper", "theme"]) {
    document.querySelectorAll("button[data-" + field + "]").forEach((item) => {
      const selected = item.dataset[field] === currentAppearance[field];
      item.classList.toggle("selected", selected);
      item.setAttribute("aria-pressed", String(selected));
      const check = item.querySelector(".appearance-check");
      if (check) check.innerHTML = selected ? icon("check") : "";
    });
  }
}
function setAppearance(value, notify = true) {
  currentAppearance = applyAppearance(value);
  syncAppearanceChoices();
  if (!notify) return;
  if (embedded)
    parent.postMessage(
      { type: "amrp-appearance", appearance: currentAppearance },
      location.origin,
    );
  else windowManager?.broadcastAppearance(currentAppearance);
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
    {
      id: "meos",
      label: "MEOS",
      icon: "shield",
      className: "police",
      access: true,
    },
  ].filter((x) => x.access && (!me.maintenance?.enabled || x.id === "admin"));
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
        `<button title="${a.label}${windowManager?.count(a.id) ? ` · ${windowManager.count(a.id)} venster(s)` : ""}" aria-label="${a.label}" data-app="${a.id}" class="${currentApp === a.id ? "active" : ""} ${windowManager?.count(a.id) ? "running" : ""}">${icon(a.icon)}</button>`,
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
async function launch(appId, navigate = null) {
  const a = apps().find((x) => x.id === appId);
  if (!a) return;
  if (appId === "meos") {
    window.open(
      "https://meos.amsterdamrp.nl/",
      "_blank",
      "noopener,noreferrer",
    );
    return;
  }
  if (windowManager) {
    toggleStart(false);
    windowManager.open(a, { navigate });
    return;
  }
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
    const saved = currentAppearance.wallpaper;
    $("app-body").innerHTML =
      `<div class="explorer"><span class="eyebrow">JOUW WERKPLEK</span><h1>Persoonlijke instellingen</h1><p>Maak deze werkplek van jou. Je thema en achtergrond worden bij jouw account bewaard, ook na opnieuw inloggen of op een ander apparaat.</p><section class="appearance-section" aria-labelledby="theme-heading"><h2 id="theme-heading">Kies je thema</h2><p>Licht of zwart voor je taakbalk, menu’s en applicatievensters.</p><div class="theme-choices">${themeOptions.map((option) => `<button class="theme-choice ${currentAppearance.theme === option.id ? "selected" : ""}" data-theme="${option.id}" aria-pressed="${currentAppearance.theme === option.id}"><span class="theme-preview theme-${option.id}" aria-hidden="true"><i></i><i></i><i></i></span><strong>${e(option.label)}</strong><small>${e(option.detail)}</small><span class="appearance-check">${currentAppearance.theme === option.id ? icon("check") : ""}</span></button>`).join("")}</div></section><section class="appearance-section" aria-labelledby="wallpaper-heading"><h2 id="wallpaper-heading">Kies je achtergrond</h2><p>Je achtergrond en thema kun je onafhankelijk van elkaar instellen.</p><div class="wallpaper-choices">${wallpaperOptions.map((option) => `<button class="wallpaper-choice ${saved === option.id ? "selected" : ""}" data-wallpaper="${option.id}" aria-pressed="${saved === option.id}"><span class="wallpaper-preview wallpaper-${option.id}"></span><strong>${e(option.label)}</strong><small>${e(option.detail)}</small><span class="wallpaper-check appearance-check">${saved === option.id ? icon("check") : ""}</span></button>`).join("")}</div></section><p class="appearance-saved">${icon("lock")} Persoonlijke instellingen · alleen voor jouw account</p></div>`;
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
        windowManager?.prune(apps().map((app) => app.id));
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
  if (embedded) {
    parent.postMessage({ type: "amrp-logout", message }, location.origin);
    return;
  }
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
    setTimeout(
      resolve,
      embedded ? 0 : Math.max(0, 2000 - (Date.now() - start)),
    ),
  );
  $("loading").hidden = true;
  $("desktop").hidden = false;
  renderDesktop();
  if (embedded) {
    const initial = new URLSearchParams(location.search).get("app");
    await launch(apps().some((a) => a.id === initial) ? initial : homeApp());
  } else if (me.maintenance?.enabled) await launch("admin");
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
        await launch("files", result);
        if (!windowManager) await workspace.openDocument(result.id);
      } else if (result.action === "training") await launch("training");
      else {
        await launch("police", result);
        if (!windowManager) await portal?.navigateSearch(result);
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
    if (embedded)
      parent.postMessage(
        { type: "amrp-open", appId: target.dataset.app },
        location.origin,
      );
    else await launch(target.dataset.app);
    return;
  }
  if (target.dataset.wallpaper || target.dataset.theme) {
    if (savingAppearance) return;
    const field = target.dataset.wallpaper ? "wallpaper" : "theme";
    savingAppearance = true;
    const choices = [
      ...document.querySelectorAll(".theme-choice,.wallpaper-choice"),
    ];
    choices.forEach((item) => {
      item.disabled = true;
    });
    try {
      const result = await api("/api/preferences", {
        method: "PUT",
        body: { [field]: target.dataset[field] },
      });
      setAppearance(result);
      toast(
        field === "theme"
          ? "Je thema is opgeslagen."
          : "Je achtergrond is opgeslagen.",
      );
    } catch (error) {
      toast(error.message, true);
    } finally {
      savingAppearance = false;
      choices.forEach((item) => {
        item.disabled = false;
      });
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
  if (action === "my-password") {
    if (me.authMode === "discord") await launch("personal");
    else passwordDialog();
  }
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
      JSON.stringify(updated.permissions) !== JSON.stringify(me.permissions) ||
      updated.maintenance?.enabled !== me.maintenance?.enabled
    ) {
      me = updated;
      windowManager?.prune(apps().map((a) => a.id));
      renderDesktop();
      if (embedded) await launch(homeApp());
      else if (me.maintenance?.enabled) await launch("admin");
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
  if (
    windowManager ||
    !embeddedVisible ||
    !me ||
    me.user.mustChange ||
    document.hidden ||
    polling
  )
    return;
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
    if (embedded) {
      parent.postMessage({ type: "amrp-search" }, location.origin);
      return;
    }
    toggleStart(true);
    $("start-search-input").focus();
  }
});
window.addEventListener("focus", checkSession);
window.addEventListener("amrp-maintenance-state", () => {
  if (me) checkSession();
});
if (embedded) {
  document.addEventListener("pointerdown", () =>
    parent.postMessage({ type: "amrp-focus" }, location.origin),
  );
  window.addEventListener("message", async (event) => {
    if (
      event.source !== parent ||
      event.origin !== location.origin ||
      !event.data ||
      typeof event.data !== "object"
    )
      return;
    const message = event.data;
    if (message.type === "amrp-appearance" && message.appearance)
      setAppearance(message.appearance, false);
    if (message.type === "amrp-visibility") {
      embeddedVisible = message.visible === true;
      if (embeddedVisible) checkChanges();
    }
    if (message.type === "amrp-close") {
      portal?.destroy?.();
      workspace?.destroy();
      ambulance?.destroy?.();
      parent.postMessage({ type: "amrp-closed" }, location.origin);
    }
    if (message.type === "amrp-navigate" && message.result) {
      try {
        if (workspace && message.result.action === "files")
          await workspace.openDocument(message.result.id);
        else if (portal) await portal.navigateSearch(message.result);
      } catch (error) {
        toast(error.message, true);
      }
    }
  });
}

fillIcons();
try {
  me = await api("/api/me");
  try {
    localStorage.setItem("amrp-last-username", me.user.username);
  } catch {
    /* Optional display preference. */
  }
  const preference = await api("/api/preferences");
  setAppearance(preference, false);
  if (!embedded)
    windowManager = createWindows({
      host: $("desktop"),
      toast,
      onFocus: (appId) => {
        currentApp = appId;
        renderDesktop();
      },
      onLogout: lockScreen,
      onOpen: (appId) => launch(appId),
      getAppearance: () => currentAppearance,
      onAppearance: (value) => setAppearance(value),
      onSearch: () => {
        toggleStart(true);
        $("start-search-input").focus();
      },
    });
  await enter();
  if (embedded) parent.postMessage({ type: "amrp-ready" }, location.origin);
  await checkChanges();
} catch (error) {
  if (error.code !== "SITE_MAINTENANCE") lockScreen(error.message);
}
