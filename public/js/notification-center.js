import { icon } from "./icons.js";
export function createNotificationCenter({ api, onOpen, poll = true }) {
  const button = document.getElementById("notifications-button");
  button.removeAttribute("data-icon");
  button.innerHTML =
    icon("bell") + '<span class="notification-count" hidden></span>';
  button.setAttribute("aria-label", "Meldingscentrum");
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-controls", "notification-center");
  const panel = document.createElement("section");
  panel.id = "notification-center";
  panel.className = "notification-center";
  panel.hidden = true;
  panel.setAttribute("aria-label", "Meldingscentrum");
  panel.innerHTML =
    '<header><div><strong>Meldingscentrum</strong><small>Jouw werkplek, op de hoogte.</small></div><button type="button" data-notification-close aria-label="Meldingscentrum sluiten">×</button></header><div class="notification-toolbar"><span data-notification-status>Ophalen…</span><button type="button" data-notification-read-all>Alles gelezen</button></div><div class="notification-items"></div>';
  document.body.append(panel);
  let busy = false,
    items = [],
    lastRefresh = 0;
  function render(data) {
    items = data.items;
    const badge = button.querySelector(".notification-count");
    badge.hidden = !data.unread;
    badge.textContent = data.unread > 99 ? "99+" : String(data.unread);
    button.setAttribute(
      "aria-label",
      `Meldingscentrum · ${data.unread} ongelezen`,
    );
    panel.querySelector("[data-notification-status]").textContent = data.unread
      ? `${data.unread} ongelezen`
      : "Helemaal bij";
    const list = panel.querySelector(".notification-items");
    list.replaceChildren();
    if (!items.length) {
      const p = document.createElement("p");
      p.className = "notification-empty";
      p.textContent =
        "Nog geen meldingen. Updates over je aanvragen, opleidingen en roepnummer verschijnen hier.";
      list.append(p);
    }
    for (const item of items) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "notification-item" + (!item.read_at ? " unread" : "");
      row.dataset.notificationId = item.id;
      const heading = document.createElement("strong"),
        body = document.createElement("span"),
        date = document.createElement("small");
      heading.textContent = item.title;
      body.textContent = item.body;
      date.textContent = new Date(item.created_at).toLocaleString("nl-NL", {
        dateStyle: "medium",
        timeStyle: "short",
      });
      row.append(heading, body, date);
      list.append(row);
    }
  }
  async function refresh(force = false) {
    if (busy || document.hidden || (!force && Date.now() - lastRefresh < 60000))
      return;
    busy = true;
    lastRefresh = Date.now();
    try {
      render(await api("/api/notifications"));
    } catch {
      panel.querySelector("[data-notification-status]").textContent =
        "Verbinding tijdelijk onderbroken";
    } finally {
      busy = false;
    }
  }
  function close() {
    panel.hidden = true;
    button.setAttribute("aria-expanded", "false");
  }
  panel.addEventListener("click", async (ev) => {
    const target = ev.target.closest("button");
    if (!target) return;
    if (target.hasAttribute("data-notification-close")) {
      close();
      button.focus();
      return;
    }
    target.disabled = true;
    try {
      if (target.hasAttribute("data-notification-read-all"))
        await api("/api/notifications/read-all", { method: "POST" });
      else {
        const item = items.find((x) => x.id === target.dataset.notificationId);
        if (!item) return;
        await api(
          "/api/notifications/" + encodeURIComponent(item.id) + "/read",
          { method: "POST" },
        );
        if (["requests", "training", "police", "admin"].includes(item.app)) {
          close();
          await onOpen(item.app);
        }
      }
      await refresh(true);
    } catch (error) {
      panel.querySelector("[data-notification-status]").textContent =
        error.message;
    } finally {
      target.disabled = false;
    }
  });
  document.addEventListener("pointerdown", (ev) => {
    if (
      !panel.hidden &&
      !panel.contains(ev.target) &&
      !button.contains(ev.target)
    )
      close();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !panel.hidden) {
      close();
      button.focus();
    }
  });
  if (poll) setInterval(refresh, 60000);
  if (poll)
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) refresh();
    });
  refresh();
  return {
    refresh,
    toggle() {
      panel.hidden = !panel.hidden;
      button.setAttribute("aria-expanded", String(!panel.hidden));
      if (!panel.hidden) refresh(true);
    },
  };
}
