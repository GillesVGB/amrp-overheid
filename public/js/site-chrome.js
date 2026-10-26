// The outer desktop owns the footer; app documents reuse its visible taskbar.
if (window.parent === window) {
  let creditBusy = false,
    maintenanceBusy = false,
    lastCreditCheck = 0,
    lastMaintenanceCheck = 0;
  async function updateCredit() {
    if (creditBusy || document.hidden || Date.now() - lastCreditCheck < 60000)
      return;
    creditBusy = true;
    lastCreditCheck = Date.now();
    try {
      const response = await fetch("/api/creator", {
        signal: AbortSignal.timeout(6500),
      });
      if (!response.ok) return;
      const profile = await response.json();
      if (profile.discordId !== "960090714950225970" || !profile.avatarUrl)
        return;
      const url = new URL(profile.avatarUrl);
      if (url.origin !== "https://cdn.discordapp.com") return;
      document.querySelectorAll("[data-creator-avatar]").forEach((image) => {
        if (image.getAttribute("src") === url.href) return;
        image.onload = () => {
          image.hidden = false;
        };
        image.onerror = () => {
          image.hidden = true;
        };
        image.src = url.href;
      });
    } catch {
      /* Keep the last known avatar, or the initial G. */
    } finally {
      creditBusy = false;
    }
  }
  async function updateMaintenance() {
    if (
      maintenanceBusy ||
      document.hidden ||
      Date.now() - lastMaintenanceCheck < 60000
    )
      return;
    maintenanceBusy = true;
    lastMaintenanceCheck = Date.now();
    try {
      const response = await fetch("/api/site-status", {
        signal: AbortSignal.timeout(6500),
      });
      if (!response.ok) return;
      const { maintenance } = await response.json();
      const handled = !window.dispatchEvent(
        new CustomEvent("amrp-maintenance-state", {
          detail: maintenance,
          cancelable: true,
        }),
      );
      const reason = document.getElementById("maintenance-reason");
      if (reason) {
        document.body.dataset.maintenance = maintenance.enabled
          ? "active"
          : "available";
        const stateLabel = document.getElementById("maintenance-state-label");
        if (stateLabel)
          stateLabel.textContent = maintenance.enabled
            ? "Onderhoud"
            : "Weer beschikbaar";
        const intro = document.getElementById("maintenance-intro");
        if (intro)
          intro.textContent = maintenance.enabled
            ? "We werken aan de digitale werkplek. Zo kun je straks weer prettig en betrouwbaar aan de slag."
            : "De werkzaamheden zijn afgerond. Je kunt de digitale werkplek weer gebruiken.";
        reason.textContent = maintenance.enabled
          ? maintenance.reason
          : "De werkplek is weer beschikbaar. Je kunt opnieuw aanmelden.";
        document.getElementById("maintenance-title").textContent =
          maintenance.enabled
            ? "Even ruimte voor verbetering."
            : "De werkplek is beschikbaar";
        const login = document.getElementById("maintenance-login");
        login.href = maintenance.enabled
          ? "/login.html?beheer=1"
          : "/login.html";
        login.textContent = maintenance.enabled
          ? "Beheerder aanmelden"
          : "Naar aanmelden";
      } else if (
        maintenance.enabled &&
        !(
          location.pathname === "/login.html" &&
          new URLSearchParams(location.search).get("beheer") === "1"
        )
      ) {
        if (handled) return;
        const me = await fetch("/api/me", {
          cache: "no-store",
          signal: AbortSignal.timeout(6500),
        });
        if (me.ok && (await me.json()).permissions?.admin) return;
        location.replace("/onderhoud.html");
      }
    } catch {
      /* Temporary connection failure must not lock a working session. */
    } finally {
      maintenanceBusy = false;
    }
  }
  updateCredit();
  updateMaintenance();
  setInterval(updateCredit, 60000);
  setInterval(updateMaintenance, 60000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      updateCredit();
      updateMaintenance();
    }
  });
}
