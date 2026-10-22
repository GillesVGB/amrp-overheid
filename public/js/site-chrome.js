// The outer desktop owns the footer; app documents reuse its visible taskbar.
if (window.parent === window) {
  let creditBusy = false, maintenanceBusy = false, previousMaintenance;
  async function updateCredit() {
    if (creditBusy || document.hidden) return;
    creditBusy = true;
    try {
      const response = await fetch('/api/creator', {cache:'no-store', signal:AbortSignal.timeout(6500)});
      if (!response.ok) return;
      const profile = await response.json();
      if (profile.discordId !== '960090714950225970' || !profile.avatarUrl) return;
      const url = new URL(profile.avatarUrl);
      if (url.origin !== 'https://cdn.discordapp.com') return;
      document.querySelectorAll('[data-creator-avatar]').forEach(image => {
        if (image.getAttribute('src') === url.href) return;
        image.onload = () => {image.hidden = false;};
        image.onerror = () => {image.hidden = true;};
        image.src = url.href;
      });
    } catch { /* Keep the last known avatar, or the initial G. */ }
    finally {creditBusy = false;}
  }
  async function updateMaintenance() {
    if (maintenanceBusy || document.hidden) return;
    maintenanceBusy = true;
    try {
      const response = await fetch('/api/site-status', {cache:'no-store', signal:AbortSignal.timeout(6500)});
      if (!response.ok) return;
      const {maintenance} = await response.json();
      if (previousMaintenance !== maintenance.enabled) {
        previousMaintenance = maintenance.enabled;
        window.dispatchEvent(new CustomEvent('amrp-maintenance-state', {detail: maintenance}));
      }
      const reason = document.getElementById('maintenance-reason');
      if (reason) {
        reason.textContent = maintenance.enabled ? maintenance.reason : 'De werkplek is weer beschikbaar. Je kunt opnieuw aanmelden.';
        document.getElementById('maintenance-title').textContent = maintenance.enabled ? 'Tijdelijk in onderhoud' : 'De werkplek is beschikbaar';
        const login = document.getElementById('maintenance-login');
        login.href = maintenance.enabled ? '/login.html?beheer=1' : '/login.html';
        login.textContent = maintenance.enabled ? 'Beheerder aanmelden' : 'Naar aanmelden';
      } else if (maintenance.enabled && !(location.pathname === '/login.html' && new URLSearchParams(location.search).get('beheer') === '1')) {
        const me = await fetch('/api/me', {cache:'no-store', signal:AbortSignal.timeout(6500)});
        if (me.ok && (await me.json()).permissions?.admin) return;
        location.replace('/onderhoud.html');
      }
    } catch { /* Temporary connection failure must not lock a working session. */ }
    finally {maintenanceBusy = false;}
  }
  updateCredit(); updateMaintenance();
  setInterval(updateCredit, 30000); setInterval(updateMaintenance, 10000);
  document.addEventListener('visibilitychange', () => {if (!document.hidden) {updateCredit(); updateMaintenance();}});
}
