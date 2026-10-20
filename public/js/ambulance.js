import { icon } from "./icons.js";
import { escapeHtml as e } from "./politie.js";
import { bindDraft } from "./drafts.js";

const statuses = [
  "Nieuw",
  "Eenheid toegewezen",
  "Onderweg",
  "Ter plaatse",
  "Afgerond",
];
const date = (value) =>
  new Date(value).toLocaleString("nl-NL", {
    dateStyle: "short",
    timeStyle: "short",
  });

export function createAmbulance({ api, me, toast }) {
  const root = document.getElementById("app-body");
  let calls = [],
    draft = null,
    editing = false,
    destroyed = false;

  function callCard(call) {
    const closed = call.status === "Afgerond";
    return `<article class="ambulance-call ${call.priority === "Spoed" ? "urgent" : ""} ${closed ? "completed" : ""}">
      <div class="ambulance-call-heading"><div><span class="call-number">${e(call.call_number)}</span><span class="priority-badge ${call.priority === "Spoed" ? "urgent" : ""}">${e(call.priority)}</span></div><span class="status-badge">${e(call.status)}</span></div>
      <h3>${e(call.location)}</h3><p>${e(call.summary)}</p>
      <div class="ambulance-call-meta"><span>${icon("users")} ${e(call.unit || "Nog geen eenheid")}</span><span>Aangemaakt door ${e(call.created_by)} · ${e(date(call.created_at))}</span></div>
      <form class="ambulance-call-edit" data-id="${e(call.id)}">
        <label>Status<select name="status">${statuses.map((status) => `<option ${status === call.status ? "selected" : ""}>${e(status)}</option>`).join("")}</select></label>
        <label>Eenheid<input name="unit" maxlength="60" value="${e(call.unit)}" placeholder="Bijv. Ambulance 12-301"></label>
        <button class="button secondary" type="submit">${icon("check")} Bijwerken</button>
      </form>
    </article>`;
  }

  function render() {
    draft?.destroy();
    editing = false;
    const open = calls.filter((call) => call.status !== "Afgerond");
    const completed = calls.filter((call) => call.status === "Afgerond");
    root.innerHTML = `<div class="ambulance-workspace">
      <header class="page-heading"><div><span class="eyebrow">${e(me.settings.name)} · HULPDIENSTEN</span><h1>Ambulance</h1><p>Coördinatie van RP-meldingen en ingezette eenheden.</p></div><div class="heading-actions"><button class="button secondary" data-action="refresh">${icon("refresh")} Vernieuwen</button></div></header>
      <div class="stats-grid ambulance-stats"><div class="stat-card good"><span>Open meldingen</span>${icon("ambulance")}<strong>${open.length}</strong><small>Actuele inzet</small></div><div class="stat-card"><span>Spoedmeldingen</span>${icon("alert")}<strong>${open.filter((call) => call.priority === "Spoed").length}</strong><small>Prioriteit spoed</small></div><div class="stat-card"><span>Afgerond</span>${icon("check")}<strong>${completed.length}</strong><small>In dit overzicht</small></div></div>
      <div class="ambulance-columns"><section class="panel"><div class="panel-heading"><div><h2>Inzetoverzicht</h2><p>De meest recente 200 meldingen</p></div></div><div class="ambulance-call-list">${open.length ? open.map(callCard).join("") : `<div class="empty-state">${icon("ambulance")}<strong>Geen open meldingen</strong><p>Nieuwe inzetten verschijnen hier.</p></div>`}</div>${completed.length ? `<details class="ambulance-completed"><summary>Afgeronde meldingen (${completed.length})</summary><div class="ambulance-call-list">${completed.map(callCard).join("")}</div></details>` : ""}</section>
      <section class="panel ambulance-create"><div class="panel-heading"><div><h2>Nieuwe melding</h2><p>Leg een inzet vast voor de roleplay.</p></div></div><form id="ambulance-create-form" class="panel-body"><label class="field">Prioriteit<select name="priority"><option>Regulier</option><option>Spoed</option></select></label><label class="field">Locatie<input name="location" maxlength="120" placeholder="Straat, wijk of herkenningspunt" required></label><label class="field">Korte RP-melding<textarea name="summary" maxlength="500" rows="4" placeholder="Beschrijf de melding zonder echte medische persoonsgegevens." required></textarea></label><label class="field">Eenheid<input name="unit" maxlength="60" placeholder="Bijv. Ambulance 12-301 (optioneel)"></label><button class="button primary" type="submit">${icon("plus")} Melding aanmaken</button><small class="ambulance-privacy">Gebruik uitsluitend fictieve roleplay-informatie. Vul geen echte medische of persoonsgegevens in.</small></form></section></div>
      <div class="security-note">${icon("lock")} Alleen accounts met de juiste dienst- of beheerdersrechten kunnen meldingen bekijken en wijzigen. Wijzigingen worden geregistreerd in het activiteitenlog.</div>
    </div>`;

    draft = bindDraft(
      root.querySelector("#ambulance-create-form"),
      "ambulance-new-call",
      { api, userId: me.user.id },
    );
    root.oninput = () => {
      editing = true;
    };
    root.onchange = () => {
      editing = true;
    };
    root
      .querySelector("#ambulance-create-form")
      .addEventListener("submit", async (event) => {
        event.preventDefault();
        const button = event.submitter;
        button.disabled = true;
        try {
          await api("/api/ambulance/calls", {
            method: "POST",
            body: Object.fromEntries(new FormData(event.currentTarget)),
          });
          await draft.clear();
          toast("De ambulance-melding is aangemaakt.");
          await load();
        } catch (error) {
          toast(error.message, true);
        } finally {
          button.disabled = false;
        }
      });

    root.querySelectorAll(".ambulance-call-edit").forEach((form) => {
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const call = calls.find((item) => item.id === form.dataset.id);
        const button = event.submitter;
        if (!call) return;
        button.disabled = true;
        try {
          await api("/api/ambulance/calls/" + encodeURIComponent(call.id), {
            method: "PUT",
            body: {
              priority: call.priority,
              status: form.elements.status.value,
              location: call.location,
              summary: call.summary,
              unit: form.elements.unit.value,
            },
          });
          toast("De melding is bijgewerkt.");
          await load();
        } catch (error) {
          toast(error.message, true);
        } finally {
          button.disabled = false;
        }
      });
    });

    root
      .querySelector('[data-action="refresh"]')
      .addEventListener("click", load);
  }

  async function load() {
    try {
      calls = (await api("/api/ambulance/calls")).calls;
      if (destroyed) return;
      render();
    } catch (error) {
      toast(error.message, true);
    }
  }

  return {
    open: load,
    async refresh() {
      if (editing || draft?.dirty) return false;
      await load();
      return true;
    },
    destroy() {
      destroyed = true;
      draft?.destroy();
      root.oninput = null;
      root.onchange = null;
    },
  };
}
