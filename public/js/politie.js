import { icon } from "./icons.js";
import { bindDraft } from "./drafts.js";
import { nextCallsign } from "./callsigns.js";
export const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const e = escapeHtml,
  $ = (id) => document.getElementById(id),
  date = (value) =>
    new Date(value).toLocaleString("nl-NL", {
      dateStyle: "short",
      timeStyle: "short",
    }),
  initials = (name) =>
    name
      .split(/[ ._-]/)
      .filter(Boolean)
      .slice(0, 2)
      .map((x) => x[0])
      .join("")
      .toUpperCase();
const action = (name, label, ico, cls = "secondary", id = "") =>
  `<button class="button ${cls}" data-portal="${name}" data-id="${e(id)}">${icon(ico)}${label}</button>`;
const tiny = (name, label, ico, id, cls = "") =>
  `<button class="icon-button ${cls}" data-portal="${name}" data-id="${e(id)}" title="${label}" aria-label="${label}">${icon(ico)}</button>`;
const empty = (title, body, ico = "folder") =>
  `<div class="empty-state">${icon(ico)}<strong>${title}</strong><p>${body}</p></div>`;
const field = (label, name, value = "", type = "text", extra = "") =>
  `<label class="field">${label}<input name="${name}" type="${type}" value="${e(value)}" ${extra}></label>`;
const select = (label, name, items, value, extra = "") =>
  `<label class="field">${label}<select name="${name}" ${extra}>${items.map((x) => `<option value="${e(x.id)}" ${x.id === value ? "selected" : ""}>${e(x.label ?? x.name ?? x.number)}</option>`).join("")}</select></label>`;
const textArea = (label, name, value = "", extra = "") =>
  `<label class="field">${label}<textarea name="${name}" ${extra}>${e(value)}</textarea></label>`;
const readOnly = () =>
  `<span class="read-only-tag">${icon("lock")} Alleen lezen</span>`;
const accountPermissionLabels = {
  policeRead: "Politie lezen",
  policeWrite: "Politie beheren",
  archive: "Archief",
  audit: "Activiteitenlog",
  ranks: "Rangen beheren",
  ambulance: "Ambulance",
};
const accountProfileLabels = {
  discord: "Volgt Discord-rollen",
  "police-agent": "Politieagent",
  command: "Korpsleiding",
  ambulance: "Ambulance",
  archive: "Archiefmedewerker",
  custom: "Aangepaste rol",
};
const accountProfileScopes = {
  discord: [],
  "police-agent": ["policeRead"],
  command: ["policeRead", "policeWrite", "archive", "audit", "ranks"],
  ambulance: ["ambulance"],
  archive: ["policeRead", "archive"],
  custom: [],
};
const accountPermissionEntries = Object.entries(accountPermissionLabels);
const routes = [
  {
    id: "dashboard",
    label: "Overzicht",
    icon: "grid",
    right: "policeRead",
    section: "police",
  },
  {
    id: "dutyboard",
    label: "Dienstbord",
    icon: "activity",
    right: "policeRead",
    section: "police",
  },
  {
    id: "personnel",
    label: "Personeel",
    icon: "users",
    right: "policeRead",
    section: "police",
  },
  {
    id: "callsigns",
    label: "Roepnummers",
    icon: "table",
    right: "policeRead",
    section: "police",
  },
  {
    id: "archive",
    label: "Archief",
    icon: "folder",
    right: "archive",
    section: "police",
  },
  {
    id: "ranks",
    label: "Rangen & reeksen",
    icon: "badge",
    right: "ranks",
    section: "police",
  },
  {
    id: "audit",
    label: "Activiteitenlog",
    icon: "clock",
    right: "audit",
    section: "police",
  },
  {
    id: "owner",
    label: "Beheerstart",
    icon: "grid",
    right: "accounts",
    section: "admin",
  },
  {
    id: "accounts",
    label: "Accounts",
    icon: "lock",
    right: "accounts",
    section: "admin",
  },
  {
    id: "system-audit",
    label: "Activiteitenlog",
    icon: "clock",
    right: "audit",
    section: "admin",
  },
  {
    id: "settings",
    label: "Systeeminstellingen",
    icon: "settings",
    right: "settings",
    section: "admin",
  },
];
export function createPortal({
  api,
  me,
  toast,
  onSettings,
  section = "police",
}) {
  let data = {},
    tab = "dashboard",
    query = "",
    rankFilter = "",
    statusFilter = "",
    categoryFilter = "",
    auditActor = "",
    auditAction = "",
    auditFrom = "",
    auditTo = "",
    sort = "name",
    sortDirection = 1,
    selectedCallsigns = new Set(),
    formDraft = null;
  async function load() {
    data = await api("/api/bootstrap");
    selectedCallsigns = new Set(
      [...selectedCallsigns].filter((id) =>
        data.callsigns.some((row) => row.id === id && !row.personnel_id),
      ),
    );
  }
  function header(title, subtitle, buttons = "") {
    return `<div class="page-heading"><div><span class="eyebrow">${section === "admin" ? "OVERHEID AMSTERDAM" : "POLITIE AMSTERDAM"}</span><h1>${title}</h1><p>${subtitle}</p></div><div class="heading-actions">${buttons}</div></div>`;
  }
  function stat(label, value, ico, sub, good = false) {
    return `<div class="stat-card ${good ? "good" : ""}"><span>${label}</span>${icon(ico)}<strong>${value}</strong><small>${sub}</small></div>`;
  }
  function panel(title, content, button = "") {
    return `<section class="panel"><div class="panel-heading"><h2>${title}</h2>${button}</div>${content}</section>`;
  }
  function rankOptions() {
    return data.ranks
      .map(
        (x) =>
          `<option value="${x.id}" ${rankFilter === x.id ? "selected" : ""}>${e(x.label)}</option>`,
      )
      .join("");
  }
  function toolbar(kind, controls = "") {
    return `<div class="toolbar"><label class="search-control">${icon("search")}<input id="table-search" type="search" value="${e(query)}" placeholder="${kind === "archive" ? "Zoeken op titel, datum of categorie..." : "Naam, rang of roepnummer..."}" aria-label="Zoeken"></label>${kind !== "archive" ? `<select id="rank-filter" aria-label="Filter op rang"><option value="">Alle rangen</option>${rankOptions()}</select>` : ""}${controls}</div>`;
  }
  function rowsFiltered(rows) {
    return rows
      .filter(
        (x) =>
          (!rankFilter || x.rank_id === rankFilter) &&
          (!statusFilter ||
            (statusFilter === "free"
              ? !x.personnel_id
              : statusFilter === "active"
                ? x.active === 1
                : x.active === 0)) &&
          (!query ||
            [
              x.discord_name,
              x.discord_id,
              x.rank,
              x.number,
              x.callsign,
              x.place,
            ]
              .join(" ")
              .toLowerCase()
              .includes(query.toLowerCase())),
      )
      .sort(
        (a, b) =>
          String(
            sort === "rank"
              ? a.rank_code
              : sort === "number"
                ? a.number || a.callsign
                : a.discord_name || "",
          ).localeCompare(
            String(
              sort === "rank"
                ? b.rank_code
                : sort === "number"
                  ? b.number || b.callsign
                  : b.discord_name || "",
            ),
            "nl",
            { numeric: true },
          ) * sortDirection,
      );
  }
  function personCell(x) {
    return `<div class="person-cell"><span class="user-initials">${e(initials(x.discord_name))}</span><div><strong>${e(x.discord_name)}</strong><small>${e(x.discord_id)}</small></div></div>`;
  }
  function personRoles(person) {
    try {
      const roles = JSON.parse(person.discord_roles || "[]");
      return Array.isArray(roles) ? roles : [];
    } catch {
      return [];
    }
  }
  function dashboard() {
    const p = data.personnel,
      active = p.filter((x) => x.active).length,
      assigned = data.callsigns.filter((x) => x.personnel_id).length;
    return (
      header(
        "Goed aan het werk.",
        `Welkom, ${e(me.discordName)}. Dit is het actuele overzicht van jouw korps.`,
        action("refresh", "Vernieuwen", "refresh"),
      ) +
      `<div class="stats-grid">${stat("Personeelsleden", p.length, "users", "Alle geregistreerde medewerkers")}${stat("Actief personeel", active, "activity", `${p.length - active} inactieve medewerkers`, true)}${stat("Toegewezen nummers", assigned, "badge", "Gekoppeld aan een medewerker")}${stat("Vrije roepnummers", data.callsigns.length - assigned, "table", "Beschikbaar binnen de reeksen")}</div><div class="two-column">${panel(
        "Personeel per rang",
        `<div class="panel-body">${data.ranks
          .map((r) => {
            const n = p.filter((x) => x.rank_id === r.id).length;
            return `<div class="mini-rank"><span>${e(r.label)}</span><div class="bar-track"><progress value="${n}" max="${Math.max(1, p.length)}" aria-label="${e(r.label)}"></progress></div><strong>${n}</strong></div>`;
          })
          .join("")}</div>`,
      )}${panel(
        me.permissions.audit ? "Recente activiteiten" : "Jouw toegangsrechten",
        `<div class="panel-body">${
          me.permissions.audit
            ? data.audit
                .slice(0, 5)
                .map(
                  (x) =>
                    `<div class="activity-row"><span class="activity-dot">${icon("clock")}</span><div><strong>${e(x.action.replaceAll(".", " · ").replaceAll("_", " "))}</strong><small>${e(x.actor_name)} · ${date(x.created_at)}</small></div></div>`,
                )
                .join("") ||
              empty(
                "Nog geen wijzigingen",
                "Belangrijke acties verschijnen hier.",
              )
            : [
                "Personeelslijst bekijken",
                "Roepnummers zoeken en kopiëren",
                "Actuele Discord-rolcontrole",
              ]
                .map(
                  (x) =>
                    `<div class="activity-row"><span class="activity-dot">${icon("check")}</span><strong>${x}</strong></div>`,
                )
                .join("")
        }</div>`,
      )}</div>${panel("Personeelsoverzicht", personnelTable(rowsFiltered(p).slice(0, 5)), `<button data-tab="personnel">Alles bekijken ${icon("arrow")}</button>`)}<div class="security-note">${icon("shield")} ${me.permissions.policeWrite ? "Je hebt beheerrechten. Wijzigingen worden blijvend opgeslagen en geregistreerd in het activiteitenlog." : "Je hebt leesrechten. Personeelsgegevens en roepnummers worden beheerd door de korpsleiding."}</div>`
    );
  }
  function dutyboard() {
    const active = data.personnel.filter((person) => person.active);
    return (
      header(
        "Dienstbord",
        "Actieve medewerkers, hun rang, roepnummer en standplaats in één overzicht.",
        action("refresh", "Vernieuwen", "refresh"),
      ) +
      `<div class="stats-grid">${stat("Actief op het bord", active.length, "activity", "Volgens de personeelsstatus", true)}${stat("Inactief", data.personnel.length - active.length, "users", "Niet ingeroosterd of buiten dienst")}</div>${panel("Actieve dienst", personnelTable(rowsFiltered(active)), `<button data-tab="personnel">Personeel beheren ${icon("arrow")}</button>`)}<p class="panel-note">De status komt uit de personeelslijst. Dit bord toont geen live locatiegegevens.</p>`
    );
  }
  function ownerDashboard() {
    const audits = data.audit || [],
      active = data.personnel.filter((x) => x.active);
    return (
      header(
        "Systeembeheer",
        `Welkom, ${e(me.discordName)}. Beheer accounts en instellingen van het portaal.`,
        action("refresh", "Vernieuwen", "refresh"),
      ) +
      `<div class="stats-grid">${stat("Actieve accounts", data.accounts.filter((x) => x.enabled).length, "users", "Met portaaltoegang", true)}${stat("Politiepersoneel", data.personnel.length, "shield", `${active.length} actief`)}${stat("Roepnummers", data.callsigns.length, "table", `${data.callsigns.filter((x) => !x.personnel_id).length} vrij`)}</div><div class="two-column">${panel("Beheer", `<div class="panel-body"><button class="button secondary" data-tab="accounts">Accounts beheren ${icon("arrow")}</button><button class="button secondary" data-tab="settings">Systeeminstellingen ${icon("arrow")}</button></div>`)}${panel(
        "Laatste wijzigingen",
        `<div class="panel-body">${
          audits
            .slice(0, 6)
            .map(
              (x) =>
                `<div class="activity-row"><span class="activity-dot">${icon("clock")}</span><div><strong>${e(x.action.replaceAll(".", " · ").replaceAll("_", " "))}</strong><small>${e(x.actor_name)} · ${date(x.created_at)}</small></div></div>`,
            )
            .join("") ||
          empty("Nog geen wijzigingen", "Beheeracties verschijnen hier.")
        }</div>`,
      )}</div>`
    );
  }
  function personnelTable(rows) {
    return rows.length
      ? `<div class="table-scroll"><table><thead><tr><th><button data-sort="name">Medewerker ↕</button></th><th><button data-sort="rank">Rang ↕</button></th><th><button data-sort="number">Roepnummer ↕</button></th><th>Standplaats</th><th>Status</th><th>Acties</th></tr></thead><tbody>${rows.map((x) => `<tr><td>${personCell(x)}</td><td><span class="rank-tag">${e(x.rank)}</span></td><td><span class="callsign">${e(x.callsign || "—")}</span>${x.callsign ? tiny("copy", "Roepnummer kopiëren", "copy", x.callsign) : x.callsign_issue ? `<small class="callsign-warning" title="${e(x.callsign_issue)}">Controle nodig</small>` : ""}</td><td>${e(x.place || "Niet ingesteld")}</td><td><span class="tag ${x.active ? "active" : "inactive"}">${x.active ? "Actief" : "Inactief"}</span></td><td><div class="row-actions">${tiny("view-person", "Personeelslid bekijken", "file", x.id)}${me.permissions.policeWrite ? (!x.callsign ? tiny("assign-person-number", "Vrij roepnummer koppelen", "badge", x.id) : "") + tiny("edit-person", "Bewerken", "edit", x.id) + tiny("delete-person", "Verwijderen", "trash", x.id, "danger") : ""}</div></td></tr>`).join("")}</tbody></table></div>`
      : empty(
          "Geen personeel gevonden",
          "Voeg een medewerker toe of pas je zoekopdracht aan.",
          "users",
        );
  }
  function personnel() {
    const rows = rowsFiltered(data.personnel);
    return (
      header(
        "Personeel",
        "Het personeel van Politie Amsterdam, overzichtelijk op één plek.",
        me.permissions.policeWrite
          ? action("sync-discord", "Discord synchroniseren", "refresh") +
              action("add-person", "Medewerker toevoegen", "plus", "primary")
          : readOnly(),
      ) +
      `<div class="security-note">${icon("discord")} ${data.discord?.lastSync ? "Laatst bijgewerkt vanuit Discord: " + date(data.discord.lastSync) + ". Hoogste gekoppelde rang wordt gebruikt." : "Personeel kan automatisch uit de overheids-Discord worden opgehaald."}${data.discord?.callsignConflicts ? ` ${data.discord.callsignConflicts} roepnummer(s) vragen controle door de korpsleiding.` : ""}${data.discord?.unranked ? ` ${data.discord.unranked} Discord-lid/leden met een politierol missen een gekoppelde rang.` : ""}${data.discord?.error ? " " + e(data.discord.error) : ""} Standplaatsgegevens worden handmatig ingevuld.</div><br>` +
      panel(
        "Alle medewerkers",
        toolbar(
          "personnel",
          `<select id="status-filter" aria-label="Filter op status"><option value="">Alle statussen</option><option value="active" ${statusFilter === "active" ? "selected" : ""}>Actief</option><option value="inactive" ${statusFilter === "inactive" ? "selected" : ""}>Inactief</option></select><span class="toolbar-count">${rows.length} medewerkers</span>`,
        ) + `<div id="results">${personnelTable(rows)}</div>`,
      ) +
      (data.discord?.unrankedMembers?.length
        ? `<br>${panel("Discordleden zonder gekoppelde rang", `<div class="table-scroll"><table><thead><tr><th>Discord-naam</th><th>Discord-rollen</th><th>Vervolg</th></tr></thead><tbody>${data.discord.unrankedMembers.map((x) => `<tr><td>${e(x.name)}<small class="person-cell-id">${e(x.discordId)}</small></td><td>${x.roles.map((role) => `<span class="rank-tag">${e(role)}</span>`).join(" ")}</td><td>Rangkoppeling controleren</td></tr>`).join("")}</tbody></table></div><p class="panel-note">Deze leden hebben een algemene politierol, maar geen rol die aan een rang is gekoppeld. De synchronisatie verzint geen rang.</p>`)} `
        : "")
    );
  }
  function callsigns() {
    const rows = rowsFiltered(data.callsigns);
    const freeRows = rows.filter((x) => !x.personnel_id);
    const allVisibleSelected =
      freeRows.length > 0 && freeRows.every((x) => selectedCallsigns.has(x.id));
    return (
      header(
        "Roepnummerregister",
        "Het centrale register. Zoek een nummer, bekijk de toewijzing of kopieer direct.",
        me.permissions.policeWrite
          ? action("export", "CSV exporteren", "download") +
              action("import-callsigns", "CSV importeren", "upload") +
              action("deleted-callsigns", "Verwijderde nummers", "history") +
              action("add-number", "Extra roepnummer", "plus", "primary")
          : readOnly(),
      ) +
      `<div class="panel">${toolbar("callsigns", `<select id="status-filter" aria-label="Filter op bezetting"><option value="">Alle roepnummers</option><option value="free" ${statusFilter === "free" ? "selected" : ""}>Alleen vrije nummers</option><option value="active" ${statusFilter === "active" ? "selected" : ""}>Actief toegewezen</option></select>${me.permissions.policeWrite ? `<label class="callsign-select-all"><input id="select-visible-callsigns" type="checkbox" ${allVisibleSelected ? "checked" : ""} ${freeRows.length ? "" : "disabled"}> Selecteer vrije</label><button id="delete-selected-callsigns" class="button danger" data-portal="delete-selected-callsigns" ${selectedCallsigns.size ? "" : "disabled"}>${icon("trash")} Verwijderen (<span>${selectedCallsigns.size}</span>)</button>` : ""}<span class="toolbar-count">${rows.length} regels</span>`)}</div><div id="results">${callsignSections(rows)}</div>`
    );
  }
  function callsignSections(rows) {
    return (
      data.ranks
        .filter(
          (r) =>
            (!rankFilter || rankFilter === r.id) &&
            rows.some((x) => x.rank_id === r.id),
        )
        .map((r) => {
          const items = rows
            .filter((x) => x.rank_id === r.id)
            .sort((a, b) => a.slot - b.slot);
          return `<section class="sheet-section"><div class="sheet-title"><strong><em>${e(r.code)}</em>${e(r.label)}</strong><span>${items.length} regels ${r.special ? "· speciaal ingesteld" : ""}</span>${me.permissions.policeWrite ? action("add-number", "Extra roepnummer", "plus", "secondary", r.id) : ""}</div><div class="table-scroll"><table><thead><tr>${me.permissions.policeWrite ? "<th>Selecteer</th>" : ""}<th>Roepnummer</th><th>Discord-naam</th><th>Plaats</th><th>Rang</th>${me.permissions.policeWrite ? "<th>Beheer</th>" : ""}</tr></thead><tbody>${items.map((x) => `<tr>${me.permissions.policeWrite ? `<td><input class="callsign-select" type="checkbox" data-id="${e(x.id)}" aria-label="Selecteer ${e(x.number)}" ${selectedCallsigns.has(x.id) ? "checked" : ""} ${x.personnel_id ? 'disabled title="Maak eerst vrij"' : ""}></td>` : ""}<td><span class="callsign">${e(x.number)}</span>${tiny("copy", "Roepnummer kopiëren", "copy", x.number)}</td><td>${x.discord_name ? e(x.discord_name) : '<span class="free-text">Vrij beschikbaar</span>'}</td><td>${e(x.place || "—")}</td><td><span class="rank-tag">${e(r.label)}</span></td>${me.permissions.policeWrite ? `<td><div class="row-actions">${tiny("edit-number", "Roepnummer bewerken", "edit", x.id)}${!x.personnel_id ? tiny("delete-number", "Roepnummer verwijderen", "trash", x.id, "danger") : ""}</div></td>` : ""}</tr>`).join("")}</tbody></table></div></section>`;
        })
        .join("") ||
      empty(
        "Geen roepnummers gevonden",
        "Pas de filters of zoekopdracht aan.",
        "table",
      )
    );
  }
  function archive() {
    const rows = archiveFiltered();
    return (
      header(
        "Korpsarchief",
        "Documenten, notities en beeldmateriaal. Alleen voor bevoegde medewerkers.",
        action("categories", "Categorieën", "folder") +
          action("add-archive", "Item toevoegen", "plus", "primary"),
      ) +
      `<div class="panel">${toolbar("archive", `<select id="category-filter" aria-label="Categorie"><option value="">Alle categorieën</option>${data.categories.map((x) => `<option value="${x.id}" ${categoryFilter === x.id ? "selected" : ""}>${e(x.name)}</option>`).join("")}</select><select id="archive-sort" aria-label="Sortering"><option value="date">Nieuwste eerst</option><option value="name" ${sort === "name" ? "selected" : ""}>Titel A–Z</option></select><span class="toolbar-count">${rows.length} items</span>`)}</div><div id="results">${archiveCards(rows)}</div>`
    );
  }
  function archiveFiltered() {
    return data.archive
      .filter(
        (x) =>
          (!categoryFilter || x.category_id === categoryFilter) &&
          (!query ||
            [
              x.title,
              x.description,
              date(x.updated_at),
              data.categories.find((c) => c.id === x.category_id)?.name,
            ]
              .join(" ")
              .toLowerCase()
              .includes(query.toLowerCase())),
      )
      .sort((a, b) =>
        sort === "name"
          ? a.title.localeCompare(b.title, "nl")
          : b.updated_at.localeCompare(a.updated_at),
      );
  }
  function archiveCards(rows) {
    return rows.length
      ? `<div class="archive-grid">${rows.map((x) => `<button class="archive-card" data-portal="view-archive" data-id="${x.id}">${icon(x.filename ? "file" : "folder")}<span class="archive-category">${e(data.categories.find((c) => c.id === x.category_id)?.name)}</span><h3>${e(x.title)}</h3><p>${e(x.description || x.note || x.filename)}</p><small><span>${date(x.updated_at)}</span><span>${x.filename ? Math.ceil(x.size / 1024) + " KB" : "Notitie"}</span></small></button>`).join("")}</div>`
      : empty(
          "Je archief begint hier",
          "Bewaar een eerste notitie of upload een bestand.",
        );
  }
  function ranks() {
    return (
      header(
        "Rangen & nummerreeksen",
        "Stel iedere rang en het aantal beschikbare regels afzonderlijk in.",
        action("add-rank", "Rang toevoegen", "plus", "primary"),
      ) +
      `<div class="security-note">${icon("table")} De reeksen 01 t/m 05 worden afzonderlijk ingesteld. Overige rangen beginnen met 30 regels. Toegewezen regels kunnen niet zomaar worden verwijderd.</div><br>` +
      panel(
        "Nummerreeksen",
        `<div class="table-scroll"><table><thead><tr><th>Reeks</th><th>Rang</th><th>Type</th><th>Regels</th><th>Toegewezen</th><th>Beheer</th></tr></thead><tbody>${data.ranks.map((x) => `<tr><td class="callsign">${e(x.code)}</td><td>${e(x.label)}</td><td>${x.special ? "Speciaal" : "Standaard"}</td><td>${x.capacity}</td><td>${data.callsigns.filter((c) => c.rank_id === x.id && c.personnel_id).length}</td><td>${tiny("edit-rank", "Rang instellen", "edit", x.id)}${tiny("delete-rank", "Rang verwijderen", "trash", x.id, "danger")}</td></tr>`).join("")}</tbody></table></div>`,
      )
    );
  }
  function auditPage() {
    const rows = filteredAudit();
    return (
      header(
        "Activiteitenlog",
        "De laatste 300 beheeracties. Geregistreerd met uitvoerder en tijdstip.",
        action("refresh", "Vernieuwen", "refresh"),
      ) +
      panel(
        "Geregistreerde wijzigingen",
        `<div class="toolbar"><label class="search-control">${icon("search")}<input id="table-search" type="search" value="${e(query)}" placeholder="Zoeken in het log..." aria-label="Zoeken in activiteiten"></label><select id="audit-action" aria-label="Filter op actie"><option value="">Alle acties</option>${[
          ...new Set(data.audit.map((x) => x.action)),
        ]
          .sort()
          .map(
            (x) =>
              `<option value="${e(x)}" ${auditAction === x ? "selected" : ""}>${e(x)}</option>`,
          )
          .join(
            "",
          )}</select><select id="audit-actor" aria-label="Filter op medewerker"><option value="">Alle medewerkers</option>${[
          ...new Set(data.audit.map((x) => x.actor_name)),
        ]
          .sort((a, b) => a.localeCompare(b, "nl"))
          .map(
            (x) =>
              `<option value="${e(x)}" ${auditActor === x ? "selected" : ""}>${e(x)}</option>`,
          )
          .join(
            "",
          )}</select><label class="audit-date-filter">Vanaf<input id="audit-from" type="date" value="${e(auditFrom)}" aria-label="Vanaf datum"></label><label class="audit-date-filter">Tot<input id="audit-to" type="date" value="${e(auditTo)}" aria-label="Tot datum"></label><span class="toolbar-count">${rows.length} acties</span></div><div id="results">${auditTable(rows)}</div>`,
      )
    );
  }
  function filteredAudit() {
    return data.audit.filter(
      (x) =>
        (!auditAction || x.action === auditAction) &&
        (!auditActor || x.actor_name === auditActor) &&
        (!auditFrom ||
          x.created_at >= new Date(auditFrom + "T00:00:00").toISOString()) &&
        (!auditTo ||
          x.created_at <
            new Date(
              new Date(auditTo + "T00:00:00").getTime() + 86400000,
            ).toISOString()) &&
        (!query ||
          [x.actor_name, x.action, x.target, date(x.created_at)]
            .join(" ")
            .toLowerCase()
            .includes(query.toLowerCase())),
    );
  }
  function auditTable(rows) {
    return rows.length
      ? `<div class="table-scroll"><table><thead><tr><th>Tijdstip</th><th>Uitgevoerd door</th><th>Actie</th><th>Details</th></tr></thead><tbody>${rows.map((x) => `<tr><td>${date(x.created_at)}</td><td>${e(x.actor_name)}</td><td class="audit-action">${e(x.action)}</td><td>${tiny("view-audit", "Wijziging bekijken", "file", String(x.id))}</td></tr>`).join("")}</tbody></table></div>`
      : empty(
          "Geen activiteiten gevonden",
          "Pas je zoekopdracht aan.",
          "clock",
        );
  }
  function accounts() {
    return (
      header(
        "Toegangsbeheer",
        "Stel per account een portaalrol en bevoegdheden in. De gekoppelde Discord-identiteit blijft altijd verplicht.",
        action("add-account", "Account toevoegen", "plus", "primary"),
      ) +
      panel(
        "Overheidsaccounts",
        `<div class="table-scroll"><table><thead><tr><th>Gebruikersnaam</th><th>Discord-ID</th><th>Portaalrol & bevoegdheden</th><th>Status</th><th>Aanmelden</th><th>Beheer</th></tr></thead><tbody>${data.accounts
          .map((x) => {
            const ownerAccount = (data.settings?.roles?.owner || []).includes(
              x.discordId,
            );
            const profile = ownerAccount
              ? "Eigenaar (Discord)"
              : accountProfileLabels[x.accessProfile] ||
                accountProfileLabels.discord;
            const grants = ownerAccount
              ? ["Eigenaar · volledige rechten"]
              : accountPermissionEntries
                  .filter(([key]) => x.accessPermissions?.[key])
                  .map(([, label]) => label);
            return `<tr><td>${e(x.username)}</td><td class="callsign">${e(x.discordId)}</td><td class="access-cell"><strong>${e(profile)}</strong><div class="permission-chips">${grants.length ? grants.map((label) => `<span class="permission-chip">${e(label)}</span>`).join("") : `<span class="permission-muted">Discord bepaalt toegang</span>`}</div></td><td><span class="tag ${x.enabled ? "active" : "inactive"}">${x.enabled ? "Toegang actief" : "Uitgeschakeld"}</span></td><td>Discord</td><td>${tiny("edit-account", "Account en rechten beheren", "settings", x.id)}${x.id !== me.user.id ? tiny("delete-account", "Account verwijderen", "trash", x.id, "danger") : ""}</td></tr>`;
          })
          .join("")}</tbody></table></div>`,
      )
    );
  }
  function settings() {
    const s = data.settings;
    return (
      header(
        "Systeeminstellingen",
        "Configureer toegangsrollen en beschikbare overheidsdiensten.",
      ) +
      `<form id="settings-form" class="panel settings-form"><section class="settings-section"><h3>Werkplekomgeving</h3><p>Instellingen gelden direct voor alle gebruikers van dit portaal.</p>${field("Omgevingsnaam", "name", s.name, "text", 'required maxlength="80"')}</section><section class="settings-section"><h3>Discord-rollen</h3><p>Gebruik rol-ID’s. Scheid meerdere ID’s met een komma. Je eigen beheerrol moet behouden blijven.</p><div class="form-grid">${Object.entries(
        {
          admin: "Overheidsbeheerder",
          police: "Politieagent · alleen lezen",
          command: "Korpsleiding · politiebeheer",
          ambulance: "Ambulancedienst",
        },
      )
        .map(([key, label]) =>
          field(
            label,
            "role_" + key,
            s.roles[key].join(", "),
            "text",
            key === "admin" ? "required" : "",
          ),
        )
        .join(
          "",
        )}</div><label class="field checkbox"><input type="checkbox" name="ambulanceEnabled" ${s.ambulanceEnabled ? "checked" : ""}> Ambulancewerkplek inschakelen</label></section><section class="settings-section"><h3>Afzonderlijke bevoegdheden</h3><p>Optionele extra Discord-rollen. Leeg laten om de standaardrechten te behouden. Schrijfrechten geven geen toegang tot account- of systeembeheer.</p><div class="form-grid">${Object.entries(
        {
          policeRead: "Politie lezen",
          policeWrite: "Personeel & roepnummers beheren",
          archive: "Archief beheren",
          audit: "Activiteitenlog bekijken",
        },
      )
        .map(([key, label]) =>
          field(label, "grant_" + key, s.grants[key].join(", ")),
        )
        .join(
          "",
        )}</div></section><footer><button class="button primary" type="submit">${icon("check")} Instellingen opslaan</button></footer></form>`
    );
  }
  function render() {
    const available = routes.filter(
      (x) => x.section === section && me.permissions[x.right],
    );
    if (!available.some((x) => x.id === tab))
      tab = available[0]?.id || "dashboard";
    const label = routes.find((x) => x.id === tab)?.label;
    const appLabel = section === "admin" ? "SYSTEEMBEHEER" : "POLITIE";
    $("app-body").innerHTML =
      `<aside class="police-sidebar"><div class="agency-brand">${icon(section === "admin" ? "settings" : "shield")}<div><strong>${appLabel}</strong><small>AMSTERDAM</small></div></div><span class="nav-label">WERKOMGEVING</span><nav class="police-nav">${available.map((x) => `<button data-tab="${x.id}" class="${tab === x.id ? "active" : ""}" title="${x.label}">${icon(x.icon)}<span>${x.label}</span></button>`).join("")}</nav><div class="sidebar-bottom"><span class="status-dot"></span><div>Beveiligde omgeving<small>Discord-identiteit gecontroleerd</small></div></div></aside><main class="portal-main"><header class="portal-topbar"><div class="breadcrumb">Overheid ${icon("chevron")} ${appLabel} ${icon("chevron")} <strong>${label}</strong></div><div class="portal-user"><span class="user-initials">${e(initials(me.discordName))}</span><div>${e(me.discordName)}<small>${me.permissions.owner ? "Eigenaar" : me.permissions.admin ? "Overheidsbeheerder" : me.permissions.policeWrite ? "Korpsleiding" : "Politieagent"}</small></div></div></header><div class="portal-content">${({ dashboard, dutyboard, personnel, callsigns, archive, ranks, audit: auditPage, "system-audit": auditPage, owner: ownerDashboard, accounts, settings }[tab] || dashboard)()}</div></main>`;
    $("app-body").onclick = click;
    $("app-body").oninput = input;
    $("app-body").onchange = change;
    $("app-body").onsubmit = submitSettings;
  }
  function updateResults() {
    const root = $("results");
    if (!root) return;
    if (tab === "personnel")
      root.innerHTML = personnelTable(rowsFiltered(data.personnel));
    if (tab === "callsigns")
      root.innerHTML = callsignSections(rowsFiltered(data.callsigns));
    if (tab === "callsigns") {
      const freeRows = rowsFiltered(data.callsigns).filter(
          (row) => !row.personnel_id,
        ),
        selectVisible = $("select-visible-callsigns"),
        deleteSelected = $("delete-selected-callsigns");
      if (selectVisible) {
        selectVisible.disabled = freeRows.length === 0;
        selectVisible.checked =
          freeRows.length > 0 &&
          freeRows.every((row) => selectedCallsigns.has(row.id));
      }
      if (deleteSelected) {
        deleteSelected.disabled = selectedCallsigns.size === 0;
        deleteSelected.querySelector("span").textContent =
          selectedCallsigns.size;
      }
    }
    if (tab === "archive") root.innerHTML = archiveCards(archiveFiltered());
    if (tab === "audit") root.innerHTML = auditTable(filteredAudit());
    const count = document.querySelector(".toolbar-count");
    if (count)
      count.textContent =
        (tab === "personnel"
          ? rowsFiltered(data.personnel).length
          : tab === "callsigns"
            ? rowsFiltered(data.callsigns).length
            : tab === "archive"
              ? archiveFiltered().length
              : document.querySelectorAll("#results tbody tr").length) +
        (tab === "personnel"
          ? " medewerkers"
          : tab === "callsigns"
            ? " regels"
            : tab === "archive"
              ? " items"
              : " acties");
  }
  function input(ev) {
    if (ev.target.id === "table-search") {
      query = ev.target.value;
      updateResults();
    }
  }
  function change(ev) {
    if (ev.target.id === "audit-action") auditAction = ev.target.value;
    if (ev.target.id === "audit-actor") auditActor = ev.target.value;
    if (ev.target.id === "audit-from") auditFrom = ev.target.value;
    if (ev.target.id === "audit-to") auditTo = ev.target.value;
    if (ev.target.id === "select-visible-callsigns") {
      for (const row of rowsFiltered(data.callsigns)) {
        if (row.personnel_id) continue;
        if (ev.target.checked) selectedCallsigns.add(row.id);
        else selectedCallsigns.delete(row.id);
      }
      updateResults();
      return;
    }
    if (ev.target.matches(".callsign-select")) {
      if (ev.target.checked) selectedCallsigns.add(ev.target.dataset.id);
      else selectedCallsigns.delete(ev.target.dataset.id);
      updateResults();
      return;
    }
    if (ev.target.id === "rank-filter") rankFilter = ev.target.value;
    if (ev.target.id === "status-filter") statusFilter = ev.target.value;
    if (ev.target.id === "category-filter") categoryFilter = ev.target.value;
    if (ev.target.id === "archive-sort") sort = ev.target.value;
    updateResults();
  }
  function modal(
    title,
    html,
    onSave,
    { button = "Opslaan", read = false } = {},
  ) {
    formDraft?.destroy();
    formDraft = null;
    $("modal-title").textContent = title;
    $("modal-body").innerHTML = html;
    $("modal-error").textContent = "";
    $("modal-save").hidden = read;
    $("modal-save").textContent = button;
    $("modal-save").disabled = false;
    $("dialog")
      .querySelectorAll('[data-action="close-modal"]')
      .forEach((x) => (x.hidden = false));
    $("dialog").oncancel = null;
    $("dialog").showModal();
    if (!read) {
      const identity = [...$("modal-form").querySelectorAll("[name]")]
        .map((input) => input.name + "=" + input.value)
        .join("|");
      let hash = 0;
      for (const char of identity)
        hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
      formDraft = bindDraft(
        $("modal-form"),
        `police-${section}-${title.replace(/[^a-zA-Z0-9_-]/g, "-")}-${hash}`.slice(
          0,
          120,
        ),
        { api, userId: me.user.id },
      );
    }
    $("modal-form").onsubmit = async (ev) => {
      ev.preventDefault();
      if (!onSave) return;
      $("modal-save").disabled = true;
      try {
        await onSave(new FormData(ev.target));
        await formDraft?.clear();
        $("dialog").close();
        await load();
        render();
        toast("De wijziging is opgeslagen.");
      } catch (error) {
        $("modal-error").textContent = error.message;
      } finally {
        $("modal-save").disabled = false;
      }
    };
    $("modal-body").onchange = null;
    $("modal-body").onclick = click;
  }
  function importCallsignsModal() {
    let csv = "",
      previewReady = false;
    modal(
      "Roepnummers importeren",
      `<p>Upload een CSV met de kolommen <strong>Roepnummer</strong> en <strong>Rang</strong>. Gebruik de rangnaam of nummerreeks. Bestaande nummers en toewijzingen blijven behouden. Maximaal 500 regels, 90 kB.</p><label class="field">CSV-bestand<input id="callsign-csv" type="file" accept=".csv,text/csv" required></label><div id="csv-preview" aria-live="polite"></div>`,
      async () => {
        if (!previewReady)
          throw Error(
            "Kies eerst een geldig CSV-bestand en controleer het voorbeeld.",
          );
        const result = await api("/api/callsigns/import", {
          method: "POST",
          body: { csv },
        });
        toast(`${result.imported} roepnummers geïmporteerd.`);
      },
      { button: "Importeren" },
    );
    $("modal-save").disabled = true;
    $("callsign-csv").onchange = async (event) => {
      previewReady = false;
      $("modal-save").disabled = true;
      const file = event.target.files[0];
      if (!file) return;
      try {
        if (file.size > 90000) throw Error("Kies een CSV van maximaal 90 kB.");
        csv = await file.text();
        const preview = await api("/api/callsigns/import/preview", {
          method: "POST",
          body: { csv },
        });
        $("csv-preview").innerHTML =
          `<p>${preview.valid} geldig · ${preview.invalid} met fouten. Er wordt pas geïmporteerd als alle regels geldig zijn.</p><div class="table-scroll csv-preview"><table><thead><tr><th>Regel</th><th>Roepnummer</th><th>Rang</th><th>Controle</th></tr></thead><tbody>${preview.rows.map((r) => `<tr><td>${r.line}</td><td>${e(r.number)}</td><td>${e(r.rank)}</td><td>${e(r.error || "Geldig")}</td></tr>`).join("")}</tbody></table></div>`;
        previewReady = !preview.invalid;
        $("modal-save").disabled = !previewReady;
        $("modal-error").textContent = "";
      } catch (error) {
        $("modal-error").textContent = error.message;
        $("csv-preview").textContent = "";
      }
    };
  }
  const freeNumbers = (rankId, currentId) => [
    { id: "", label: "Geen roepnummer" },
    ...data.callsigns
      .filter(
        (x) => x.rank_id === rankId && (!x.personnel_id || x.id === currentId),
      )
      .map((x) => ({ id: x.id, label: x.number })),
  ];
  function personForm(row) {
    const rankId = row?.rank_id || data.ranks[0]?.id;
    modal(
      row ? "Personeelslid bewerken" : "Medewerker toevoegen",
      `<div class="form-grid">${field("Discord-naam", "discordName", row?.discord_name || "", "text", 'required maxlength="80"')}${field("Discord-gebruikers-ID", "discordId", row?.discord_id || "", "text", 'required pattern="[0-9]{17,20}"')}</div>${select(
        "Rang",
        "rankId",
        data.ranks.map((x) => ({ id: x.id, label: x.label })),
        rankId,
        "required",
      )}${select("Roepnummer", "callsignId", freeNumbers(rankId, row?.callsign_id), row?.callsign_id || "")}${field("Plaats / standplaats", "place", row?.place || "", "text", 'maxlength="100"')}<label class="field checkbox"><input type="checkbox" name="active" ${!row || row.active ? "checked" : ""}> Medewerker is actief</label>`,
      async (form) => {
        await api("/api/personnel" + (row ? "/" + row.id : ""), {
          method: row ? "PUT" : "POST",
          body: { ...Object.fromEntries(form), active: form.has("active") },
        });
      },
    );
    $("modal-body").onchange = (ev) => {
      if (ev.target.name === "rankId") {
        const selector = $("modal-body").querySelector('[name="callsignId"]');
        selector.innerHTML = freeNumbers(ev.target.value, row?.callsign_id)
          .map((x) => `<option value="${x.id}">${e(x.label)}</option>`)
          .join("");
      }
    };
  }
  function assignCallsignForm(person) {
    const available = data.callsigns
      .filter((x) => x.rank_id === person.rank_id && !x.personnel_id)
      .map((x) => ({ id: x.id, label: x.number }));
    if (!available.length) {
      toast("Er zijn geen vrije roepnummers voor deze rang.", true);
      return;
    }
    modal(
      "Roepnummer koppelen aan " + person.discord_name,
      `${select("Vrij roepnummer", "callsignId", available, available[0].id, "required")}<p class="panel-note">Alleen vrije roepnummers uit de rang ${e(person.rank)} worden getoond.</p>`,
      async (form) => {
        await api("/api/personnel/" + person.id, {
          method: "PUT",
          body: {
            discordName: person.discord_name,
            discordId: person.discord_id,
            rankId: person.rank_id,
            callsignId: form.get("callsignId"),
            place: person.place || "",
            active: Boolean(person.active),
          },
        });
      },
    );
  }
  async function deletedCallsignsModal() {
    const { callsigns: deleted } = await api("/api/callsigns/deleted");
    modal(
      "Verwijderde roepnummers",
      deleted.length
        ? `<p class="panel-note">Je kunt een nummer binnen 30 minuten herstellen. Daarna wordt het definitief opgeruimd.</p><div class="table-scroll"><table><thead><tr><th>Nummer</th><th>Rang</th><th>Hersteltermijn</th><th></th></tr></thead><tbody>${deleted.map((x) => `<tr><td class="callsign">${e(x.number)}</td><td>${e(data.ranks.find((r) => r.id === x.rank_id)?.label || "Onbekende rang")}</td><td>${Math.max(0, Math.ceil((new Date(x.expiresAt) - Date.now()) / 60000))} min.</td><td>${tiny("restore-number", "Roepnummer herstellen", "refresh", x.id)}</td></tr>`).join("")}</tbody></table></div>`
        : empty(
            "Geen verwijderde nummers",
            "Verwijderde nummers zijn 30 minuten herstelbaar.",
            "history",
          ),
      null,
      { read: true },
    );
  }
  function numberForm(row, preferredRankId = "") {
    const rankId = row?.rank_id || preferredRankId || data.ranks[0]?.id;
    const suggestedNumber = (id) => {
      const rank = data.ranks.find((rank) => rank.id === id);
      return rank ? nextCallsign(data.callsigns, rank) : "";
    };
    const people = (rank) => [
      { id: "", label: "Vrij beschikbaar" },
      ...data.personnel
        .filter(
          (x) =>
            x.rank_id === rank && (!x.callsign_id || x.callsign_id === row?.id),
        )
        .map((x) => ({ id: x.id, label: x.discord_name })),
    ];
    modal(
      row ? "Roepnummer bewerken" : "Roepnummer toevoegen",
      `${
        row
          ? ""
          : select(
              "Rang / nummerreeks",
              "rankId",
              data.ranks.map((x) => ({
                id: x.id,
                label: x.code + " · " + x.label,
              })),
              rankId,
              "required",
            )
      }${field("Roepnummer", "number", row?.number ?? suggestedNumber(rankId), "text", 'required maxlength="40" placeholder="[11-01 ★★★]"')}${select("Toewijzen aan", "personnelId", people(rankId), row?.personnel_id || "")}${field("Plaats / standplaats", "place", row?.place || "", "text", 'maxlength="100"')}<div class="security-note">${icon("lock")} Alleen personeel met dezelfde rang kan aan deze reeks worden gekoppeld. Dubbele toewijzingen worden geweigerd.</div>`,
      (form) =>
        api("/api/callsigns" + (row ? "/" + row.id : ""), {
          method: row ? "PUT" : "POST",
          body: Object.fromEntries(form),
        }),
    );
    $("modal-body").onchange = (ev) => {
      if (ev.target.name === "rankId") {
        $("modal-body").querySelector('[name="number"]').value =
          suggestedNumber(ev.target.value);
        $("modal-body").querySelector('[name="personnelId"]').innerHTML =
          people(ev.target.value)
            .map((x) => `<option value="${x.id}">${e(x.label)}</option>`)
            .join("");
      }
    };
  }
  async function rankForm(row) {
    let roles = [];
    try {
      roles = (await api("/api/discord/roles")).roles;
    } catch (error) {
      toast(error.message, true);
    }
    modal(
      row ? "Rang en reeks instellen" : "Rang toevoegen",
      `${row ? `<div class="security-note">Reeks ${e(row.code)} · ${row.special ? "speciaal, afzonderlijk ingesteld" : "standaard"}</div><br>` : field("Nummerreeks (twee cijfers)", "code", "", "text", 'required pattern="[0-9]{2}" maxlength="2"')}${field("Naam van de rang", "label", row?.label || "", "text", 'required maxlength="80"')}${roles.length ? select("Discord-rangrol", "discordRoleId", [{ id: "", label: "Geen automatische rangkoppeling" }, ...roles], row?.discord_role_id || "") : field("Discord-rangrol-ID", "discordRoleId", row?.discord_role_id || "", "text", 'pattern="[0-9]{17,20}"')}${field("Aantal roepnummerregels", "capacity", row?.capacity ?? 30, "number", 'min="0" max="500" required')}<div class="security-note">${icon("table")} Bij uitbreiding worden vrije regels toegevoegd. Verkleinen kan alleen als de te verwijderen regels niet zijn toegewezen.</div>`,
      (form) =>
        api("/api/ranks" + (row ? "/" + row.id : ""), {
          method: row ? "PUT" : "POST",
          body: Object.fromEntries(form),
        }),
    );
  }
  function archiveForm(row) {
    modal(
      row ? "Archiefitem bewerken" : "Toevoegen aan archief",
      `${field("Titel", "title", row?.title || "", "text", 'required maxlength="160"')}${select("Categorie", "categoryId", data.categories, row?.category_id || data.categories[0]?.id, "required")}${textArea("Beschrijving", "description", row?.description || "", 'maxlength="1000"')}${textArea("Notitie", "note", row?.note || "", 'class="large" maxlength="25000"')}<label class="field">${row?.filename ? "Bestand vervangen (optioneel)" : "Bestand toevoegen (optioneel)"}<input name="file" type="file" accept=".png,.jpg,.jpeg,.gif,.webp,.pdf,.txt"><small>PNG, JPG, GIF, WebP, PDF of TXT. Maximaal 5 MB. ${row?.filename ? "Huidig bestand: " + e(row.filename) : "Bestanden zijn alleen beschikbaar na controle van je archiefrechten."}</small></label>`,
      (form) => {
        const file = form.get("file");
        if (!file?.size) form.delete("file");
        if (file?.size > 5 * 1024 * 1024)
          throw Error("Het bestand is groter dan 5 MB.");
        return api("/api/archive" + (row ? "/" + row.id : ""), {
          method: row ? "PUT" : "POST",
          body: form,
        });
      },
    );
  }
  function accountForm(row) {
    const ownerAccount = row?.id === me.user.id && me.permissions.owner;
    const profile = row?.accessProfile || (row ? "discord" : "police-agent");
    const profileOptions = Object.entries(accountProfileLabels).map(
      ([id, label]) => ({ id, label }),
    );
    const selectedScopes =
      row?.accessPermissions ||
      Object.fromEntries(
        (accountProfileScopes[profile] || []).map((key) => [key, true]),
      );
    const accessEditor = ownerAccount
      ? `<input type="hidden" name="accessProfile" value="discord"><div class="security-note access-owner-note">${icon("shield")} Dit account is eigenaar via Discord. De volledige eigenaarsrechten blijven beschermd.</div>`
      : `<div class="access-editor">${select("Portaalrol", "accessProfile", profileOptions, profile)}<fieldset class="access-permissions" ${profile === "discord" ? "hidden" : ""}><legend>Bevoegdheden</legend><div class="access-scope-grid">${accountPermissionEntries.map(([key, label]) => `<label class="access-scope"><input type="checkbox" name="scope_${key}" ${selectedScopes[key] ? "checked" : ""}><span>${e(label)}</span></label>`).join("")}</div><p>Beheer van accounts en systeeminstellingen blijft uitsluitend beschikbaar via de eigenaarrol in Discord. Ambulancetoegang werkt alleen wanneer die werkplek is ingeschakeld.</p></fieldset></div>`;
    modal(
      row ? "Account beheren" : "Overheidsaccount aanmaken",
      `<div class="form-grid">${field("Gebruikersnaam", "username", row?.username || "", "text", 'required maxlength="80" autocomplete="off"')}${field("Discord-gebruikers-ID", "discordId", row?.discordId || "", "text", 'required pattern="[0-9]{17,20}"')}</div>${field(row ? "Nieuw wachtwoord (leeg laten om te behouden)" : "Wachtwoord (minimaal 12 tekens)", "password", "", "password", `${row ? "" : "required"} minlength="12" maxlength="128" autocomplete="new-password"`)}${accessEditor}${row ? `<label class="field checkbox"><input type="checkbox" name="enabled" ${row.enabled ? "checked" : ""}> Account is ingeschakeld</label>` : ""}<div class="security-note">${icon("lock")} De gebruiker kan direct inloggen met deze gebruikersnaam en dit wachtwoord, of met het gekoppelde Discord-account. De ingestelde accountrechten blijven gelden.</div>`,
      (form) => {
        const formValues = Object.fromEntries(form);
        const accessPermissions = Object.fromEntries(
          accountPermissionEntries.map(([key]) => [
            key,
            form.has("scope_" + key),
          ]),
        );
        for (const [key] of accountPermissionEntries)
          delete formValues["scope_" + key];
        return api("/api/accounts" + (row ? "/" + row.id : ""), {
          method: row ? "PUT" : "POST",
          body: {
            ...formValues,
            accessPermissions,
            enabled: form.has("enabled"),
          },
        });
      },
    );
    if (!ownerAccount) {
      const roleSelect = $("modal-body").querySelector(
        'select[name="accessProfile"]',
      );
      const permissionSet = $("modal-body").querySelector(
        ".access-permissions",
      );
      $("modal-body").onchange = (event) => {
        if (event.target === roleSelect) {
          const selected = accountProfileScopes[roleSelect.value] || [];
          for (const [key] of accountPermissionEntries) {
            const checkbox = $("modal-body").querySelector(
              `[name="scope_${key}"]`,
            );
            checkbox.checked = selected.includes(key);
          }
          permissionSet.hidden = roleSelect.value === "discord";
        } else if (event.target.matches(".access-scope input")) {
          roleSelect.value = "custom";
        }
      };
    }
  }
  async function remove(url, message) {
    if (!confirm(message)) return;
    await api(url, { method: "DELETE", body: {} });
    await load();
    render();
    toast("Het item is verwijderd.");
  }
  async function click(ev) {
    const button = ev.target.closest("button,a");
    if (!button) return;
    try {
      if (button.dataset.tab) {
        tab = button.dataset.tab;
        query = "";
        rankFilter = "";
        statusFilter = "";
        sort = tab === "archive" ? "date" : "name";
        render();
        return;
      }
      if (button.dataset.sort) {
        sort = button.dataset.sort;
        sortDirection *= -1;
        render();
        return;
      }
      const a = button.dataset.portal,
        key = button.dataset.id;
      if (!a) return;
      if (a === "delete-selected-callsigns") {
        if (!selectedCallsigns.size) return;
        if (
          !confirm(
            `Weet je zeker dat je ${selectedCallsigns.size} vrije roepnummers wilt verwijderen? Je kunt ze binnen 30 minuten herstellen.`,
          )
        )
          return;
        const result = await api("/api/callsigns", {
          method: "DELETE",
          body: { ids: [...selectedCallsigns] },
        });
        selectedCallsigns.clear();
        await load();
        render();
        toast(
          `${result.deleted} roepnummer(s) verwijderd. Herstellen kan 30 minuten.`,
        );
        return;
      }
      if (a === "refresh") {
        await load();
        render();
        toast("Het overzicht is bijgewerkt.");
      }
      if (a === "sync-discord") {
        button.disabled = true;
        try {
          const result = await api("/api/discord/sync", {
            method: "POST",
            body: {},
          });
          await load();
          render();
          toast(
            `Discord bijgewerkt: ${result.added} toegevoegd, ${result.updated} aangepast, ${result.deactivated} inactief. ${result.unranked} zonder gekoppelde rang.`,
          );
        } finally {
          button.disabled = false;
        }
      }
      if (a === "copy") {
        try {
          await navigator.clipboard.writeText(key);
          toast("Roepnummer " + key + " gekopieerd.");
        } catch {
          modal(
            "Roepnummer kopiëren",
            field(
              "Selecteer en kopieer het nummer",
              "copy",
              key,
              "text",
              "readonly",
            ),
            null,
            { read: true },
          );
          $("modal-body").querySelector("input").select();
        }
      }
      if (a === "add-person") personForm();
      if (a === "edit-person")
        personForm(data.personnel.find((x) => x.id === key));
      if (a === "assign-person-number") {
        if ($("dialog").open) $("dialog").close();
        assignCallsignForm(data.personnel.find((x) => x.id === key));
      }
      if (a === "view-person") {
        const x = data.personnel.find((x) => x.id === key),
          roles = personRoles(x);
        modal(
          x.discord_name,
          `<dl class="help-list"><dt>Rang</dt><dd>${e(x.rank)}</dd><dt>Roepnummer</dt><dd>${e(x.callsign || "Niet toegewezen")}${x.callsign_issue ? `<br><small class="callsign-warning">${e(x.callsign_issue)}</small>` : ""}</dd><dt>Discord-ID</dt><dd>${e(x.discord_id)}</dd><dt>Plaats</dt><dd>${e(x.place || "Niet ingesteld — laat de korpsleiding dit aanvullen")}</dd><dt>Status</dt><dd>${x.active ? "Actief" : "Inactief"}</dd><dt>Discord-rollen</dt><dd>${roles.length ? roles.map((role) => `<span class="rank-tag" title="${e(role.id)}">${e(role.name)}</span>`).join(" ") : "Nog niet gesynchroniseerd"}</dd></dl><div class="heading-actions"><a class="button secondary" href="https://discord.com/users/${encodeURIComponent(x.discord_id)}" target="_blank" rel="noopener noreferrer">${icon("discord")} Discord-profiel openen</a>${me.permissions.policeWrite && !x.callsign ? action("assign-person-number", "Vrij roepnummer koppelen", "badge", "primary", x.id) : ""}</div>`,
          null,
          { read: true },
        );
      }
      if (a === "delete-person")
        await remove(
          "/api/personnel/" + key,
          "Dit personeelslid definitief verwijderen? Het roepnummer wordt vrijgemaakt.",
        );
      if (a === "add-number") numberForm(null, key);
      if (a === "edit-number")
        numberForm(data.callsigns.find((x) => x.id === key));
      if (a === "delete-number") {
        selectedCallsigns.delete(key);
        await remove(
          "/api/callsigns/" + key,
          "Dit vrije roepnummer verwijderen? Je kunt het binnen 30 minuten herstellen.",
        );
      }
      if (a === "deleted-callsigns") await deletedCallsignsModal();
      if (a === "restore-number") {
        await api("/api/callsigns/deleted/" + key + "/restore", {
          method: "POST",
          body: {},
        });
        $("dialog").close();
        await load();
        render();
        toast("Het roepnummer is hersteld.");
      }
      if (a === "add-rank") await rankForm();
      if (a === "edit-rank")
        await rankForm(data.ranks.find((x) => x.id === key));
      if (a === "delete-rank")
        await remove(
          "/api/ranks/" + key,
          "Deze rang en alle vrije roepnummers verwijderen? Dit kan alleen als er geen personeel aan is gekoppeld.",
        );
      if (a === "export") location.assign("/api/callsigns.csv");
      if (a === "import-callsigns") importCallsignsModal();
      if (a === "add-archive") archiveForm();
      if (a === "edit-archive") {
        const row = data.archive.find((x) => x.id === key);
        $("dialog").close();
        archiveForm(row);
      }
      if (a === "delete-archive") {
        $("dialog").close();
        await remove(
          "/api/archive/" + key,
          "Dit archiefitem en het eventuele bestand definitief verwijderen?",
        );
      }
      if (a === "view-archive") {
        const x = data.archive.find((x) => x.id === key);
        modal(
          x.title,
          `<span class="archive-category">${e(data.categories.find((c) => c.id === x.category_id)?.name)}</span><p class="note-text">${e(x.description)}</p>${x.mime?.startsWith("image/") ? `<img class="file-preview" src="/api/archive/${x.id}/file?preview=1" alt="${e(x.title)}">` : ""}<div class="note-text">${e(x.note)}</div>${x.filename ? `<div class="file-meta">${icon("file")}<span>${e(x.filename)}<small> · ${Math.ceil(x.size / 1024)} KB</small></span><a class="button secondary" href="/api/archive/${x.id}/file" download>${icon("download")} Downloaden</a></div>` : ""}<p class="login-help">Bijgewerkt ${date(x.updated_at)}</p><div class="heading-actions">${action("edit-archive", "Bewerken", "edit", "secondary", x.id)}${action("delete-archive", "Verwijderen", "trash", "danger", x.id)}</div>`,
          null,
          { read: true },
        );
      }
      if (a === "categories") categoryModal();
      if (a === "rename-category") {
        const x = data.categories.find((c) => c.id === key),
          name = prompt("Nieuwe categorienaam", x.name);
        if (name?.trim()) {
          await api("/api/categories/" + key, {
            method: "PUT",
            body: { name },
          });
          await load();
          $("dialog").close();
          categoryModal();
        }
      }
      if (a === "delete-category") {
        if (
          confirm(
            "Deze categorie verwijderen? Dat kan alleen als de categorie leeg is.",
          )
        ) {
          await api("/api/categories/" + key, { method: "DELETE", body: {} });
          await load();
          $("dialog").close();
          categoryModal();
        }
      }
      if (a === "add-account") accountForm();
      if (a === "edit-account")
        accountForm(data.accounts.find((x) => x.id === key));
      if (a === "delete-account")
        await remove(
          "/api/accounts/" + key,
          "Dit overheidsaccount verwijderen en alle sessies intrekken?",
        );
      if (a === "view-audit") {
        const x = data.audit.find((x) => String(x.id) === key);
        modal(
          "Details van wijziging",
          `<dl class="help-list"><dt>Actie</dt><dd>${e(x.action)}</dd><dt>Uitvoerder</dt><dd>${e(x.actor_name)} · ${date(x.created_at)}</dd><dt>Onderwerp</dt><dd>${e(x.target)}</dd></dl><pre class="audit-details">${e(JSON.stringify({ voor: x.before_json ? JSON.parse(x.before_json) : null, na: x.after_json ? JSON.parse(x.after_json) : null }, null, 2))}</pre>`,
          null,
          { read: true },
        );
      }
    } catch (error) {
      if ($("dialog").open) $("modal-error").textContent = error.message;
      else toast(error.message, true);
    }
  }
  function categoryModal() {
    modal(
      "Archiefcategorieën",
      `<div class="category-list">${data.categories.map((x) => `<div class="category-row">${icon("folder")}<span>${e(x.name)}</span>${tiny("rename-category", "Categorie hernoemen", "edit", x.id)}${tiny("delete-category", "Categorie verwijderen", "trash", x.id, "danger")}</div>`).join("")}</div><br>${field("Nieuwe categorie", "name", "", "text", 'required maxlength="80"')}`,
      (form) =>
        api("/api/categories", {
          method: "POST",
          body: Object.fromEntries(form),
        }),
      { button: "Categorie toevoegen" },
    );
  }
  async function submitSettings(ev) {
    if (ev.target.id !== "settings-form") return;
    ev.preventDefault();
    const form = new FormData(ev.target),
      split = (name) =>
        String(form.get(name) || "")
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
      body = {
        name: form.get("name"),
        ambulanceEnabled: form.has("ambulanceEnabled"),
        roles: {},
        grants: {},
      };
    for (const key of ["admin", "police", "command", "ambulance"])
      body.roles[key] = split("role_" + key);
    for (const key of ["policeRead", "policeWrite", "archive", "audit"])
      body.grants[key] = split("grant_" + key);
    const button = ev.target.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      await api("/api/settings", { method: "PUT", body });
      await load();
      await onSettings();
      render();
      toast("Instellingen zijn voor iedereen bijgewerkt.");
    } catch (error) {
      toast(error.message, true);
    } finally {
      button.disabled = false;
    }
  }
  return {
    async open(initial) {
      tab = initial;
      await load();
      render();
    },
    async refresh() {
      if ($("dialog").open || $("app-body").querySelector("form")) return false;
      await load();
      render();
      return true;
    },
    async navigateSearch(result) {
      const permitted = routes.find(
        (route) =>
          route.id === result.action &&
          me.permissions[route.right] &&
          route.section === section,
      );
      if (!permitted) return;
      tab = result.action;
      query = result.title || "";
      rankFilter = "";
      statusFilter = "";
      await load();
      render();
    },
    destroy() {
      formDraft?.destroy();
      formDraft = null;
      const root = $("app-body");
      root.onclick = null;
      root.oninput = null;
      root.onchange = null;
      root.onsubmit = null;
    },
  };
}
