import { icon } from "./icons.js";
import { escapeHtml as e } from "./politie.js";

const services = {
  shared: "Gedeeld",
  police: "Politie",
  ambulance: "Ambulance",
};
const viewNames = {
  files: "Verkenner",
  training: "Opleidingen",
  requests: "Aanvragen",
};
const requestTypes = {
  leave: "Verlof",
  training: "Opleiding",
  material: "Materiaal",
};
const requestStates = {
  pending: "In behandeling",
  approved: "Goedgekeurd",
  rejected: "Afgewezen",
};
const date = (value) =>
  value ? new Date(value).toLocaleDateString("nl-NL") : "—";
const dateTime = (value) =>
  value
    ? new Date(value).toLocaleString("nl-NL", {
        dateStyle: "short",
        timeStyle: "short",
      })
    : "—";
const bytes = (value) =>
  !value
    ? "—"
    : value < 1024
      ? `${value} B`
      : value < 1048576
        ? `${Math.ceil(value / 1024)} KB`
        : `${(value / 1048576).toFixed(1)} MB`;
const button = (action, label, ico, extra = "") =>
  `<button type="button" data-ws="${action}" ${extra}>${icon(ico)}<span>${label}</span></button>`;
const input = (label, name, value = "", attrs = "") =>
  `<label class="ws-field">${label}<input name="${name}" value="${e(value)}" ${attrs}></label>`;
const textarea = (label, name, value = "", attrs = "") =>
  `<label class="ws-field">${label}<textarea name="${name}" ${attrs}>${e(value)}</textarea></label>`;
const select = (label, name, options, value = "", attrs = "") =>
  `<label class="ws-field">${label}<select name="${name}" ${attrs}>${options.map((item) => `<option value="${e(item.id)}" ${String(item.id) === String(value) ? "selected" : ""}>${e(item.label)}</option>`).join("")}</select></label>`;
const empty = (title, text, ico = "folder") =>
  `<div class="ws-empty">${icon(ico)}<strong>${title}</strong><p>${text}</p></div>`;

/** Shared Windows workplace. All mutations still require the API's own access checks. */
export function createWorkspace({ api, me, toast, onChange = () => {} }) {
  let host,
    shell,
    dialog,
    data = null,
    view = "files",
    folderId = null,
    service = "all",
    query = "",
    layout = "list",
    selected = null;
  let destroyed = false,
    requestVersion = 0,
    loading = false,
    errorMessage = "",
    currentForm = null,
    draftTimer,
    draftWrite = Promise.resolve(),
    busyUpload = false;
  let fileSearchTimer;
  const manage = () => Boolean(data?.permissions?.manage);
  const availableServices = () => data?.permissions?.services || ["shared"];
  const folders = () => data?.folders || [];
  const documents = () => data?.documents || [];
  const idAttr = (id) => `data-id="${e(id)}"`;
  const folder = (id) =>
    folders().find((item) => String(item.id) === String(id));
  const personName = (person) =>
    person.name || person.discord_name || person.username || "Medewerker";
  const actorName = (id) =>
    String(id) === String(me.user?.id)
      ? "Jij"
      : (data?.people || []).find((item) => String(item.user_id) === String(id))
          ?.name || "Medewerker";
  const storageKey = (key) => `amrp-draft:${me.user?.id || "session"}:${key}`;
  function readLocalDraft(key) {
    try {
      return JSON.parse(localStorage.getItem(storageKey(key)) || "null");
    } catch {
      return null;
    }
  }
  function writeLocalDraft(key, value) {
    try {
      localStorage.setItem(storageKey(key), JSON.stringify(value));
    } catch {
      /* Server drafts remain available. */
    }
  }
  function formValues(form) {
    const result = Object.fromEntries(
      [...new FormData(form)].filter(([, value]) => typeof value === "string"),
    );
    form.querySelectorAll('input[type="checkbox"][name]').forEach((item) => {
      result[item.name] = item.checked;
    });
    return result;
  }
  function fillForm(form, values) {
    for (const [name, value] of Object.entries(values || {})) {
      const field = form.elements.namedItem(name);
      if (!field || name.startsWith("__")) continue;
      if (field.type === "checkbox") field.checked = Boolean(value);
      else if (field.type !== "file") field.value = value ?? "";
    }
  }
  function draftNotice(text) {
    if (dialog?.open) {
      const notice = dialog.querySelector(".ws-draft-state");
      if (notice) notice.textContent = text;
    }
  }
  function saveDraft(form = currentForm?.form, key = currentForm?.key) {
    if (!form || !key || destroyed) return;
    const value = { ...formValues(form), __savedAt: new Date().toISOString() };
    writeLocalDraft(key, value);
    draftNotice("Concept op dit apparaat bewaard…");
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      if (destroyed) return;
      draftWrite = draftWrite
        .catch(() => {})
        .then(() =>
          destroyed
            ? null
            : api(`/api/drafts/${encodeURIComponent(key)}`, {
                method: "PUT",
                body: { value },
              }),
        );
      draftWrite.then(
        () => {
          if (currentForm?.key === key)
            draftNotice("Concept automatisch opgeslagen");
        },
        () => {
          if (currentForm?.key === key)
            draftNotice(
              "Concept op dit apparaat bewaard. Online opslaan lukt nu niet.",
            );
        },
      );
    }, 650);
  }
  async function clearDraft(key) {
    clearTimeout(draftTimer);
    try {
      localStorage.removeItem(storageKey(key));
    } catch {
      /* No local storage. */
    }
    await draftWrite.catch(() => {});
    if (!destroyed)
      await api(`/api/drafts/${encodeURIComponent(key)}`, {
        method: "DELETE",
      }).catch(() => {});
  }
  function closeDialog() {
    if (!dialog?.open || currentForm?.submitting) return;
    if (currentForm?.dirty) saveDraft();
    dialog.close();
    currentForm = null;
  }
  function showDialog(title, body, { footer = "", wide = false } = {}) {
    if (destroyed || !dialog) return;
    closeDialog();
    dialog.classList.toggle("ws-dialog-wide", wide);
    dialog.setAttribute("aria-label", title);
    dialog.innerHTML = `<header class="ws-dialog-header"><h2>${e(title)}</h2><button type="button" data-ws="close-dialog" aria-label="Venster sluiten">${icon("close")}</button></header><div class="ws-dialog-body">${body}</div>${footer ? `<footer class="ws-dialog-footer">${footer}</footer>` : ""}`;
    dialog.showModal();
  }
  async function openForm({
    title,
    html,
    key,
    submit,
    label = "Opslaan",
    wide = false,
    afterFill,
  }) {
    showDialog(
      title,
      `<form id="ws-editor" class="ws-form">${html}<div class="ws-form-error" role="alert" hidden></div><div class="ws-draft-state" aria-live="polite">${key ? "Je invoer wordt automatisch als concept bewaard." : ""}</div></form>`,
      {
        footer: `<button type="button" data-ws="close-dialog">Annuleren</button><button type="submit" form="ws-editor" class="ws-primary">${e(label)}</button>`,
        wide,
      },
    );
    if (destroyed || !dialog?.open) return;
    const form = dialog.querySelector("#ws-editor"),
      local = key && readLocalDraft(key);
    currentForm = { form, key, dirty: false };
    if (local) {
      fillForm(form, local);
      draftNotice("Je opgeslagen concept is hersteld.");
    }
    afterFill?.(form);
    form.addEventListener("input", () => {
      if (currentForm?.form !== form) return;
      currentForm.dirty = true;
      saveDraft(form, key);
      afterFill?.(form);
    });
    form.addEventListener("change", () => {
      if (currentForm?.form !== form) return;
      currentForm.dirty = true;
      saveDraft(form, key);
      afterFill?.(form);
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const submitButton = dialog.querySelector('[type="submit"]'),
        errorBox = form.querySelector(".ws-form-error");
      if (currentForm?.submitting) return;
      const values = formValues(form),
        controls = [
          ...form.elements,
          ...dialog.querySelectorAll("button"),
        ].filter((control) => !control.disabled);
      currentForm.submitting = true;
      controls.forEach((control) => {
        control.disabled = true;
      });
      errorBox.hidden = true;
      try {
        await submit(values, form);
        if (destroyed) return;
        if (key) await clearDraft(key);
        if (destroyed) return;
        if (currentForm?.form === form) {
          currentForm = null;
          dialog.close();
        }
        await refresh();
        onChange();
      } catch (error) {
        if (!destroyed && form.isConnected) {
          errorBox.textContent = error.message;
          errorBox.hidden = false;
        }
      } finally {
        if (currentForm?.form === form) currentForm.submitting = false;
        controls.forEach((control) => {
          control.disabled = false;
        });
        submitButton.disabled = false;
      }
    });
    if (key) {
      api(`/api/drafts/${encodeURIComponent(key)}`)
        .then((remote) => {
          if (
            destroyed ||
            currentForm?.form !== form ||
            currentForm.dirty ||
            !remote?.value
          )
            return;
          if (
            !local ||
            new Date(remote.updated_at || remote.value.__savedAt) >
              new Date(local.__savedAt || 0)
          ) {
            fillForm(form, remote.value);
            writeLocalDraft(key, remote.value);
            draftNotice("Je online opgeslagen concept is hersteld.");
            afterFill?.(form);
          }
        })
        .catch(() => {});
    }
  }
  function chain(id) {
    const result = [],
      visited = new Set();
    while (id && !visited.has(String(id))) {
      visited.add(String(id));
      const item = folder(id);
      if (!item) break;
      result.unshift(item);
      id = item.parent_id;
    }
    return result;
  }
  function folderOptions(excludeId, includeRoot = true, onlyService) {
    return [
      ...(includeRoot ? [{ id: "", label: "Hoofdmap" }] : []),
      ...folders()
        .filter(
          (item) =>
            (!onlyService || item.service === onlyService) &&
            String(item.id) !== String(excludeId) &&
            !chain(item.id).some(
              (parent) => String(parent.id) === String(excludeId),
            ),
        )
        .map((item) => ({
          id: item.id,
          label: `${services[item.service] || "Gedeeld"} / ${chain(item.id)
            .map((parent) => parent.name)
            .join(" / ")}`,
        })),
    ];
  }
  const defaultFolder = () =>
    folderId ||
    folders().find(
      (item) =>
        item.id === `workspace-${service === "all" ? "shared" : service}`,
    )?.id ||
    folders()[0]?.id;
  function isInService(item) {
    if (service === "all") return true;
    return (
      (item.service || folder(item.folder_id)?.service || "shared") === service
    );
  }
  function selectedDocument() {
    return documents().find((item) => String(item.id) === String(selected));
  }
  function sideNav() {
    const currentFolder = folder(folderId);
    if (view !== "files")
      return `<aside class="ws-sidebar"><div class="ws-sidebar-label">${e(viewNames[view])}</div><nav aria-label="Applicatie"><button type="button" data-ws="refresh" class="active">${icon(view === "training" ? "badge" : "file")}<span>Overzicht</span></button></nav><div class="ws-sidebar-bottom">${icon("lock")}<span>Gedeelde werkplek<small>Toegang via je dienst</small></span></div></aside>`;
    return `<aside class="ws-sidebar"><div class="ws-sidebar-label">Werkplek</div><nav aria-label="Werkplek apps">${[[view, viewNames[view]]].map(([key, label]) => `<button type="button" data-ws="view" data-view="${key}" class="${view === key ? "active" : ""}">${icon(key === "files" ? "folder" : key === "training" ? "badge" : "file")}<span>${label}</span></button>`).join("")}</nav><div class="ws-sidebar-label">Locaties</div><nav aria-label="Documentlocaties"><button type="button" data-ws="service" data-service="all" class="${view === "files" && service === "all" && !folderId ? "active" : ""}">${icon("pc")}<span>Deze werkplek</span></button>${availableServices()
      .map(
        (key) =>
          `<button type="button" data-ws="service" data-service="${key}" class="${view === "files" && (service === key || currentFolder?.service === key) ? "active" : ""}">${icon(key === "police" ? "shield" : key === "ambulance" ? "ambulance" : "users")}<span>${services[key] || key}</span></button>`,
      )
      .join(
        "",
      )}</nav><div class="ws-sidebar-bottom">${icon("lock")}<span>Gedeelde werkplek<small>Toegang via je dienst</small></span></div></aside>`;
  }
  function filesView() {
    const q = query.trim().toLocaleLowerCase("nl"),
      current = folder(folderId);
    const children = folders().filter(
      (item) =>
        isInService(item) &&
        (q
          ? item.name.toLocaleLowerCase("nl").includes(q)
          : String(item.parent_id || "") === String(folderId || "")),
    );
    const rows = documents().filter(
      (item) =>
        isInService(item) &&
        (q
          ? `${item.title} ${item.filename || ""}`
              .toLocaleLowerCase("nl")
              .includes(q)
          : String(item.folder_id || "") === String(folderId || "")),
    );
    const selectedItem = selectedDocument();
    const items = [
      ...children.map((item) => ({ ...item, isFolder: true })),
      ...rows,
    ].sort(
      (a, b) =>
        Number(b.isFolder || false) - Number(a.isFolder || false) ||
        (a.name || a.title).localeCompare(b.name || b.title, "nl"),
    );
    return `<div class="ws-files-toolbar"><div class="ws-command-group">${manage() ? button("new-folder", "Nieuwe map", "folder") : ""}${button("upload", "Uploaden", "upload", busyUpload ? "disabled" : "")}${button("new-document", "Nieuw document", "plus")}</div><div class="ws-command-group">${button("layout", layout === "list" ? "Tegels" : "Details", layout === "list" ? "grid" : "table", `aria-label="Weergave wijzigen naar ${layout === "list" ? "tegels" : "details"}"`)}${button("refresh", "", "refresh", 'aria-label="Vernieuwen" title="Vernieuwen"')}</div></div>
      <div class="ws-address-row"><button type="button" data-ws="up" ${!folderId ? "disabled" : ""} aria-label="Een map omhoog" title="Een map omhoog">${icon("arrow", "ws-up-arrow")}</button><nav class="ws-address" aria-label="Mappad"><button type="button" data-ws="home">${icon("pc")}<span>Deze werkplek</span></button>${chain(
        folderId,
      )
        .map(
          (item) =>
            `${icon("chevron")}<button type="button" data-ws="folder" ${idAttr(item.id)}>${e(item.name)}</button>`,
        )
        .join(
          "",
        )}</nav><label class="ws-search">${icon("search")}<input id="ws-file-search" type="search" value="${e(query)}" placeholder="${current ? `Zoeken in ${e(current.name)}` : "Zoeken in documenten"}" aria-label="Bestanden en mappen zoeken"></label></div>
      <div class="ws-file-content"><section class="ws-file-list ${layout === "grid" ? "ws-file-grid" : ""}" aria-label="Bestanden en mappen" tabindex="0">${items.length ? (layout === "list" ? `<table class="ws-table"><thead><tr><th>Naam</th><th>Gewijzigd op</th><th>Type</th><th>Grootte</th></tr></thead><tbody>${items.map((item) => fileRow(item)).join("")}</tbody></table>` : items.map((item) => fileTile(item)).join("")) : empty(q ? "Geen zoekresultaten" : "Deze map is leeg", q ? "Probeer een andere naam of zoekterm." : "Sleep bestanden hierheen of maak een nieuw document.")}</section>${selectedItem ? detailsPanel(selectedItem) : ""}</div><footer class="ws-statusbar"><span>${items.length} ${items.length === 1 ? "item" : "items"}${service !== "all" ? ` · ${services[service]}` : ""}</span><span>${busyUpload ? "Uploaden…" : "Gedeeld opgeslagen"}</span></footer><input type="file" id="ws-upload-input" multiple hidden><div class="ws-drop-overlay" hidden>${icon("upload")}<strong>Bestanden hier neerzetten</strong><span>Maximaal 4 MB per bestand</span></div>`;
  }
  function fileType(item) {
    if (item.isFolder) return "Bestandsmap";
    if (item.kind === "document") return "Werkdocument";
    return (item.filename?.split(".").pop() || "Bestand").toUpperCase();
  }
  function fileRow(item) {
    return `<tr data-ws="${item.isFolder ? "folder" : "select-document"}" ${idAttr(item.id)} class="${String(selected) === String(item.id) && !item.isFolder ? "selected" : ""}" tabindex="0" role="button" aria-label="${e(item.isFolder ? `Map ${item.name} openen` : `Document ${item.title} selecteren`)}"><td><span class="ws-file-name ${item.isFolder ? "ws-folder-name" : ""}">${icon(item.isFolder ? "folder" : "file")}<span>${e(item.name || item.title)}</span>${item.isFolder && (item.canEdit || manage()) ? `<button type="button" data-ws="edit-folder" ${idAttr(item.id)} aria-label="Map ${e(item.name)} bewerken" title="Map bewerken">${icon("edit")}</button>` : ""}</span></td><td>${dateTime(item.updated_at || item.created_at)}</td><td>${fileType(item)}</td><td>${item.isFolder ? "—" : bytes(item.size)}</td></tr>`;
  }
  function fileTile(item) {
    return `<div class="ws-file-tile ${item.isFolder ? "ws-folder-tile" : ""} ${String(selected) === String(item.id) && !item.isFolder ? "selected" : ""}"><button type="button" data-ws="${item.isFolder ? "folder" : "select-document"}" ${idAttr(item.id)}>${icon(item.isFolder ? "folder" : "file")}<span>${e(item.name || item.title)}</span><small>${fileType(item)}</small></button>${item.isFolder && (item.canEdit || manage()) ? `<button type="button" class="ws-tile-edit" data-ws="edit-folder" ${idAttr(item.id)} aria-label="Map ${e(item.name)} bewerken">${icon("edit")}</button>` : ""}</div>`;
  }
  function detailsPanel(item) {
    return `<aside class="ws-details"><div class="ws-details-heading"><strong>Details</strong><button type="button" data-ws="clear-selection" aria-label="Details sluiten">${icon("close")}</button></div><div class="ws-details-symbol">${icon("file")}</div><h3>${e(item.title)}</h3><span class="ws-muted">${fileType(item)}</span><div class="ws-details-actions">${button("open-document", "Openen", "file", idAttr(item.id))}${item.kind === "file" ? `<a href="/api/workspace/documents/${encodeURIComponent(item.id)}/file" download>${icon("download")}Downloaden</a>` : ""}${item.canEdit || manage() ? button("edit-document", "Bewerken", "edit", idAttr(item.id)) : ""}${item.canDelete || manage() ? button("delete-document", "Verwijderen", "trash", `${idAttr(item.id)} class="ws-danger"`) : ""}</div><dl><dt>Locatie</dt><dd>${e(folder(item.folder_id)?.name || "Hoofdmap")}</dd><dt>Gewijzigd</dt><dd>${dateTime(item.updated_at)}</dd><dt>Grootte</dt><dd>${bytes(item.size)}</dd><dt>Aangemaakt door</dt><dd>${e(actorName(item.created_by))}</dd></dl></aside>`;
  }
  function trainingView() {
    const q = query.trim().toLowerCase(),
      courses = data.courses || [],
      completions = (data.completions || []).filter((item) =>
        `${item.person_name} ${item.course_name} ${item.qualification || ""}`
          .toLowerCase()
          .includes(q),
      );
    const today = new Date().toISOString().slice(0, 10);
    return `<header class="ws-page-heading"><div>${icon("badge")}<div><h1>Opleidingenregister</h1><p>Trainingen en bevoegdheden van je dienst.</p></div></div>${manage() ? `<div class="ws-command-group">${button("new-course", "Opleiding toevoegen", "plus")}${button("new-completion", "Afronding registreren", "check", 'class="ws-primary"')}</div>` : ""}</header><div class="ws-inner-content"><section class="ws-section"><div class="ws-section-heading"><h2>Opleidingen</h2><span>${courses.length} beschikbaar</span></div><div class="ws-course-list">${courses.length ? courses.map((item) => `<article class="ws-course"><div class="ws-course-symbol">${icon("badge")}</div><div><h3>${e(item.name)}</h3><p>${e(item.description || "Geen omschrijving toegevoegd.")}</p><div class="ws-course-meta"><span>${e(services[item.service] || "Gedeeld")}</span>${item.qualification ? `<span>${e(item.qualification)}</span>` : ""}<span>${item.valid_months ? `${item.valid_months} maanden geldig` : "Onbeperkt geldig"}</span>${item.active === false || item.active === 0 ? '<span class="ws-pill rejected">Inactief</span>' : ""}</div></div>${manage() ? `<div class="ws-row-actions">${button("edit-course", "", "edit", `${idAttr(item.id)} aria-label="Opleiding ${e(item.name)} bewerken"`)}</div>` : ""}</article>`).join("") : empty("Nog geen opleidingen", "Nieuwe opleidingen verschijnen hier.", "badge")}</div></section><section class="ws-section"><div class="ws-section-heading"><h2>Behaalde trainingen</h2><label class="ws-search">${icon("search")}<input id="ws-training-search" type="search" value="${e(query)}" placeholder="Zoek medewerker of training" aria-label="Opleidingenregister doorzoeken"></label></div>${completions.length ? `<div class="ws-table-scroll"><table class="ws-table"><thead><tr><th>Medewerker</th><th>Opleiding / bevoegdheid</th><th>Behaald op</th><th>Geldig tot</th><th>Status</th>${manage() ? "<th>Beheer</th>" : ""}</tr></thead><tbody>${completions.map((item) => `<tr><td>${e(item.person_name || "Medewerker")}</td><td><strong>${e(item.course_name)}</strong><small>${e(item.qualification || item.note || "")}</small></td><td>${date(item.completed_on)}</td><td>${item.expires_on ? date(item.expires_on) : "Onbeperkt"}</td><td><span class="ws-pill ${item.expires_on && item.expires_on < today ? "rejected" : "approved"}">${item.expires_on && item.expires_on < today ? "Verlopen" : "Geldig"}</span></td>${manage() ? `<td><div class="ws-row-actions">${button("edit-completion", "", "edit", `${idAttr(item.id)} aria-label="Afronding bewerken"`)}${button("delete-completion", "", "trash", `${idAttr(item.id)} aria-label="Afronding verwijderen" class="ws-danger"`)}</div></td>` : ""}</tr>`).join("")}</tbody></table></div>` : empty("Geen afrondingen gevonden", q ? "Probeer een andere zoekterm." : "Afgeronde trainingen en bijbehorende bevoegdheden verschijnen hier.", "badge")}</section></div>`;
  }
  function requestsView() {
    const rows = (data.requests || []).filter((item) =>
      `${item.title} ${item.username} ${requestTypes[item.type]} ${requestStates[item.status]}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    );
    return `<header class="ws-page-heading"><div>${icon("file")}<div><h1>Aanvragen</h1><p>${manage() ? "Beoordeel aanvragen van medewerkers." : "Dien een aanvraag in en volg de afhandeling."}</p></div></div>${button("new-request", "Nieuwe aanvraag", "plus", 'class="ws-primary"')}</header><div class="ws-inner-content"><section class="ws-section"><div class="ws-section-heading"><h2>${manage() ? "Alle aanvragen" : "Mijn aanvragen"}</h2><label class="ws-search">${icon("search")}<input type="search" id="ws-request-search" value="${e(query)}" placeholder="Zoek titel, medewerker of status" aria-label="Aanvragen doorzoeken"></label></div>${rows.length ? `<div class="ws-request-list">${rows.map((item) => `<article class="ws-request"><div class="ws-request-heading"><div><span class="ws-muted">${e(requestTypes[item.type] || item.type)} · ${e(item.username || "Medewerker")}</span><h3>${e(item.title)}</h3></div><span class="ws-pill ${e(item.status)}">${e(requestStates[item.status] || item.status)}</span></div><p class="ws-request-description">${e(item.description)}</p>${item.start_date || item.end_date ? `<p class="ws-muted">${icon("clock")} ${date(item.start_date)}${item.end_date ? ` t/m ${date(item.end_date)}` : ""}</p>` : ""}${item.course_id ? `<p class="ws-muted">Opleiding: ${e((data.courses || []).find((course) => String(course.id) === String(item.course_id))?.name || "Opleiding")}</p>` : ""}${item.review_reason ? `<div class="ws-review-note"><strong>Toelichting ${item.status === "approved" ? "goedkeuring" : "afwijzing"}</strong><p>${e(item.review_reason)}</p><small>Beoordeeld op ${dateTime(item.reviewed_at)}</small></div>` : ""}<footer><span class="ws-muted">Ingediend op ${dateTime(item.created_at)}</span>${manage() && item.status === "pending" && String(item.user_id) !== String(me.user?.id) ? button("review-request", "Beoordelen", "check", idAttr(item.id)) : ""}</footer></article>`).join("")}</div>` : empty("Geen aanvragen gevonden", query ? "Probeer een andere zoekterm." : "Nieuwe aanvragen verschijnen hier.", "file")}</section></div>`;
  }
  function paint() {
    if (destroyed || !shell) return;
    shell.innerHTML = `${sideNav()}<main class="ws-main">${errorMessage ? `<div class="ws-error" role="alert">${icon("alert")}<span>${e(errorMessage)}</span>${button("refresh", "Opnieuw proberen", "refresh")}</div>` : ""}${!data ? `<div class="ws-loading" role="status">${icon("refresh")} Werkplek laden…</div>` : view === "files" ? filesView() : view === "training" ? trainingView() : requestsView()}</main>`;
    if (view === "files") bindFileDrop();
  }
  async function refresh() {
    if (destroyed || !host || loading) return;
    const version = ++requestVersion;
    loading = true;
    try {
      const next = await api("/api/workspace/bootstrap");
      if (destroyed || version !== requestVersion) return;
      data = next;
      errorMessage = "";
      if (folderId && !folder(folderId)) folderId = null;
      if (selected && !selectedDocument()) selected = null;
      const active = document.activeElement,
        focusId = active?.id,
        selectionStart = active?.selectionStart;
      const scroll = shell.querySelector(
        ".ws-file-list, .ws-inner-content",
      )?.scrollTop;
      paint();
      const newInput =
        focusId && shell.querySelector(`#${CSS.escape(focusId)}`);
      if (newInput) {
        newInput.focus();
        if (typeof selectionStart === "number" && newInput.setSelectionRange)
          newInput.setSelectionRange(selectionStart, selectionStart);
      }
      const list = shell.querySelector(".ws-file-list, .ws-inner-content");
      if (list && scroll) list.scrollTop = scroll;
    } catch (error) {
      if (!destroyed && version === requestVersion) {
        errorMessage = error.message;
        paint();
      }
    } finally {
      if (version === requestVersion) loading = false;
    }
  }
  async function render(container, nextView = "files") {
    destroyed = false;
    view = viewNames[nextView] ? nextView : "files";
    if (host !== container || !shell?.isConnected) {
      if (host) unbind();
      host = container;
      host.innerHTML =
        '<div class="ws-shell"></div><dialog class="ws-dialog" aria-label="Werkplekvenster"></dialog>';
      shell = host.querySelector(".ws-shell");
      dialog = host.querySelector(".ws-dialog");
      host.addEventListener("click", handleClick);
      host.addEventListener("input", handleSearch);
      host.addEventListener("keydown", handleKey);
      host.addEventListener("dblclick", handleDoubleClick);
      dialog.addEventListener("cancel", (event) => {
        event.preventDefault();
        closeDialog();
      });
    }
    paint();
    await refresh();
  }
  function setFolder(id) {
    view = "files";
    folderId = id || null;
    selected = null;
    query = "";
    paint();
  }
  async function navigate({
    view: nextView,
    folderId: nextFolder,
    documentId,
  } = {}) {
    if (viewNames[nextView]) view = nextView;
    if (nextFolder !== undefined) setFolder(nextFolder);
    query = "";
    if (!data) await refresh();
    paint();
    if (documentId) await openDocument(documentId);
  }
  async function editFolder(id) {
    const item = id && folder(id),
      current = folder(folderId);
    await openForm({
      title: item ? "Map bewerken" : "Nieuwe map",
      key: `folder-${id || folderId || service}`,
      html:
        input(
          "Mapnaam",
          "name",
          item?.name || "",
          'required maxlength="120" autofocus',
        ) +
        select(
          "Bovenliggende map",
          "parent_id",
          folderOptions(id),
          item?.parent_id || folderId || "",
        ) +
        select(
          "Dienst",
          "service",
          availableServices().map((key) => ({
            id: key,
            label: services[key] || key,
          })),
          item?.service ||
            current?.service ||
            (service === "all" ? "shared" : service),
        ) +
        (item?.canDelete || (item && manage())
          ? `<button type="button" data-ws="delete-folder" ${idAttr(item.id)} class="ws-danger">${icon("trash")} Map verwijderen</button>`
          : ""),
      submit: async (values) => {
        await api(
          `/api/workspace/folders${id ? `/${encodeURIComponent(id)}` : ""}`,
          {
            method: id ? "PUT" : "POST",
            body: { ...values, parent_id: values.parent_id || null },
          },
        );
        toast(item ? "Map bijgewerkt." : "Map aangemaakt.");
      },
    });
  }
  function chooseTemplate() {
    const templates = data.templates || [];
    showDialog(
      "Nieuw document",
      `<p class="ws-intro">Kies een vaste indeling. Je kunt het document daarna aanvullen en opslaan in Verkenner.</p><div class="ws-template-list">${templates.map((item) => `<button type="button" data-ws="use-template" data-template="${e(item.key)}">${icon("file")}<span><strong>${e(item.name)}</strong><small>${e(item.description)}</small></span>${icon("chevron")}</button>`).join("")}${!templates.length ? "<p>Er zijn nog geen sjablonen beschikbaar.</p>" : ""}<button type="button" data-ws="use-template" data-template="">${icon("plus")}<span><strong>Leeg document</strong><small>Een vrije tekst zonder vaste indeling.</small></span>${icon("chevron")}</button></div>`,
    );
  }
  async function editDocument(id, templateKey = "") {
    const item =
      id && documents().find((entry) => String(entry.id) === String(id));
    const template = (data.templates || []).find(
      (entry) => entry.key === (item?.template_key || templateKey),
    );
    const fields = template?.fields || [],
      custom = item?.fields || {};
    await openForm({
      title: item ? "Document bewerken" : template?.name || "Nieuw document",
      key: `document-${id || templateKey || "blank"}-${item?.folder_id || folderId || "root"}`,
      wide: true,
      html: `<div class="ws-form-columns">${input("Titel", "title", item?.title || template?.name || "", 'required maxlength="180" autofocus')}${select("Opslaan in", "folder_id", folderOptions(null, false, item ? folder(item.folder_id)?.service : null), item?.folder_id || defaultFolder())}</div>${fields.length ? `<fieldset class="ws-template-fields"><legend>${e(template.name)} · vaste velden</legend><div class="ws-form-columns">${fields.map((field) => (field.type === "textarea" ? textarea(e(field.label), `field_${field.key}`, custom[field.key] || "", `${field.required ? "required" : ""} maxlength="10000" rows="3"`) : input(e(field.label), `field_${field.key}`, custom[field.key] || "", `type="${["date", "time", "datetime-local", "number"].includes(field.type) ? field.type : "text"}" ${field.required ? "required" : ""} maxlength="500"`))).join("")}</div></fieldset>` : ""}${textarea(fields.length ? "Aanvullende inhoud" : "Documentinhoud", "content", item?.content || (!fields.length ? template?.content || "" : ""), 'rows="10" maxlength="60000" placeholder="Schrijf hier je document…"')}<p class="ws-muted">Dit document wordt gedeeld met medewerkers die toegang hebben tot deze map.</p>`,
      submit: async (values) => {
        await api(
          `/api/workspace/documents${id ? `/${encodeURIComponent(id)}` : ""}`,
          {
            method: id ? "PUT" : "POST",
            body: {
              title: values.title,
              folder_id: values.folder_id,
              template_key: template?.key || null,
              content: values.content,
              fields: Object.fromEntries(
                fields.map((field) => [
                  field.key,
                  values[`field_${field.key}`] || "",
                ]),
              ),
            },
          },
        );
        folderId = values.folder_id;
        toast(item ? "Document bijgewerkt." : "Document opgeslagen.");
      },
    });
  }
  async function openDocument(id) {
    if (!data) await refresh();
    if (destroyed) return;
    const item = documents().find((entry) => String(entry.id) === String(id));
    if (!item) {
      toast(
        "Dit document is niet meer beschikbaar of je hebt geen toegang.",
        true,
      );
      return;
    }
    selected = item.id;
    const path = `/api/workspace/documents/${encodeURIComponent(item.id)}/file`,
      template = (data.templates || []).find(
        (entry) => entry.key === item.template_key,
      );
    let content;
    if (item.kind === "document") {
      content = `<article class="ws-document-paper"><h1>${e(item.title)}</h1>${template?.fields?.length ? `<dl class="ws-document-fields">${template.fields.map((field) => `<dt>${e(field.label)}</dt><dd>${e(item.fields?.[field.key] || "—")}</dd>`).join("")}</dl>` : ""}<div class="ws-document-text">${e(item.content || "Dit document heeft nog geen inhoud.")}</div><footer>${e(template?.name || "Werkdocument")} · Laatst gewijzigd ${dateTime(item.updated_at)}</footer></article>`;
    } else if (
      ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(item.mime)
    )
      content = `<div class="ws-image-preview"><img src="${path}?inline=1" alt="${e(item.title)}"></div>`;
    else if (item.mime === "application/pdf")
      content = `<iframe class="ws-pdf-preview" src="${path}?inline=1" title="Voorbeeld van ${e(item.title)}"></iframe><p class="ws-muted">Geen voorbeeld zichtbaar? Gebruik Downloaden om het bestand te openen.</p>`;
    else if (item.mime === "text/plain") {
      try {
        const response = await fetch(`${path}?inline=1`, {
          credentials: "same-origin",
          signal: AbortSignal.timeout(20000),
        });
        if (!response.ok)
          throw Error("Het tekstvoorbeeld is niet beschikbaar.");
        const text = await response.text();
        if (destroyed) return;
        content = `<article class="ws-document-paper"><h1>${e(item.title)}</h1><div class="ws-document-text">${e(text.slice(0, 250000))}</div>${text.length > 250000 ? '<p class="ws-muted">Het voorbeeld is ingekort. Download het bestand voor de volledige inhoud.</p>' : ""}</article>`;
      } catch (error) {
        content = empty("Voorbeeld niet beschikbaar", e(error.message), "file");
      }
    } else
      content = empty(
        "Bestand klaar om te openen",
        "Download dit bestand om het met de bijbehorende toepassing te openen.",
        "file",
      );
    showDialog(item.title, content, {
      wide: true,
      footer: `${item.kind === "document" ? button("print-document", "Afdrukken", "file", idAttr(item.id)) : `<a class="ws-primary" href="${path}" download>${icon("download")} Downloaden</a>`}${item.canEdit || manage() ? button("edit-document", "Bewerken", "edit", idAttr(item.id)) : ""}<button type="button" data-ws="close-dialog">Sluiten</button>`,
    });
    paint();
  }
  async function editFileMetadata(item) {
    await openForm({
      title: "Bestand bewerken",
      key: `file-${item.id}`,
      html:
        input("Naam", "title", item.title, 'required maxlength="180"') +
        select(
          "Map",
          "folder_id",
          folderOptions(null, false, folder(item.folder_id)?.service),
          item.folder_id,
        ),
      submit: async (values) => {
        await api(`/api/workspace/documents/${encodeURIComponent(item.id)}`, {
          method: "PUT",
          body: { title: values.title, folder_id: values.folder_id },
        });
        folderId = values.folder_id;
        toast("Bestandsgegevens bijgewerkt.");
      },
    });
  }
  async function uploadFiles(files) {
    if (busyUpload || destroyed || !files?.length) return;
    const list = [...files];
    const tooLarge = list.filter((file) => file.size > 4 * 1024 * 1024);
    if (tooLarge.length) {
      toast(
        `${tooLarge.map((file) => file.name).join(", ")}: maximaal 4 MB per bestand.`,
        true,
      );
      return;
    }
    const targetFolder = defaultFolder();
    if (!targetFolder) {
      toast("Er is geen toegankelijke map om in te uploaden.", true);
      return;
    }
    busyUpload = true;
    paint();
    let count = 0;
    try {
      for (const file of list) {
        if (destroyed) break;
        const body = new FormData();
        body.append("file", file);
        body.append("title", file.name);
        body.append("folder_id", targetFolder);
        await api("/api/workspace/documents", { method: "POST", body });
        count++;
      }
      if (!destroyed) {
        folderId = targetFolder;
        selected = null;
        toast(
          `${count} ${count === 1 ? "bestand geüpload" : "bestanden geüpload"} in ${folder(targetFolder)?.name || "de map"}.`,
        );
        onChange();
      }
    } catch (error) {
      if (!destroyed)
        toast(
          `${count ? `${count} bestanden geüpload. ` : ""}${error.message}`,
          true,
        );
    } finally {
      busyUpload = false;
      if (!destroyed) await refresh();
    }
  }
  function bindFileDrop() {
    const input = shell.querySelector("#ws-upload-input"),
      target = shell.querySelector(".ws-file-content"),
      overlay = shell.querySelector(".ws-drop-overlay");
    input?.addEventListener("change", () => uploadFiles(input.files));
    let entered = 0;
    target?.addEventListener("dragenter", (event) => {
      if (![...event.dataTransfer.types].includes("Files")) return;
      event.preventDefault();
      entered++;
      overlay.hidden = false;
    });
    target?.addEventListener("dragover", (event) => {
      if (![...event.dataTransfer.types].includes("Files")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    });
    target?.addEventListener("dragleave", () => {
      entered = Math.max(0, entered - 1);
      if (!entered) overlay.hidden = true;
    });
    target?.addEventListener("drop", (event) => {
      if (![...event.dataTransfer.types].includes("Files")) return;
      event.preventDefault();
      entered = 0;
      overlay.hidden = true;
      uploadFiles(event.dataTransfer.files);
    });
  }
  async function editCourse(id) {
    const item = (data.courses || []).find(
      (course) => String(course.id) === String(id),
    );
    await openForm({
      title: item ? "Opleiding bewerken" : "Opleiding toevoegen",
      key: `course-${id || "new"}`,
      html:
        input(
          "Naam van de opleiding",
          "name",
          item?.name || "",
          'required maxlength="140"',
        ) +
        textarea(
          "Omschrijving",
          "description",
          item?.description || "",
          'rows="3" maxlength="3000"',
        ) +
        input(
          "Bijbehorende bevoegdheid",
          "qualification",
          item?.qualification || "",
          'maxlength="160" placeholder="Bijvoorbeeld: bevoegd motorrijder"',
        ) +
        `<div class="ws-form-columns">${select(
          "Dienst",
          "service",
          availableServices().map((key) => ({
            id: key,
            label: services[key] || key,
          })),
          item?.service || "shared",
        )}${input("Geldigheid in maanden", "valid_months", item?.valid_months || "", 'type="number" min="1" max="120" placeholder="Leeg = onbeperkt"')}</div><label class="ws-checkbox"><input type="checkbox" name="active" ${!item || item.active ? "checked" : ""}> Opleiding beschikbaar voor nieuwe registraties</label>`,
      submit: async (values) => {
        await api(
          `/api/workspace/courses${id ? `/${encodeURIComponent(id)}` : ""}`,
          {
            method: id ? "PUT" : "POST",
            body: {
              ...values,
              valid_months: values.valid_months
                ? Number(values.valid_months)
                : 0,
            },
          },
        );
        toast("Opleiding opgeslagen.");
      },
    });
  }
  async function editCompletion(id) {
    const item = (data.completions || []).find(
      (entry) => String(entry.id) === String(id),
    );
    if (!(data.people || []).length || !(data.courses || []).length) {
      toast("Voeg eerst een medewerker en een opleiding toe.", true);
      return;
    }
    await openForm({
      title: item ? "Afronding bewerken" : "Behaalde opleiding registreren",
      key: `completion-${id || "new"}`,
      html:
        select(
          "Medewerker",
          "personnel_id",
          data.people.map((person) => ({
            id: person.id,
            label: personName(person),
          })),
          item?.personnel_id || item?.user_id,
        ) +
        select(
          "Opleiding",
          "course_id",
          data.courses
            .filter(
              (course) =>
                course.active || String(course.id) === String(item?.course_id),
            )
            .map((course) => ({ id: course.id, label: course.name })),
          item?.course_id,
        ) +
        `<div class="ws-form-columns">${input("Behaald op", "completed_on", item?.completed_on || new Date().toISOString().slice(0, 10), 'type="date" required')}${input("Geldig tot (optioneel)", "expires_on", item?.expires_on || "", 'type="date"')}</div><p class="ws-muted">Bij een nieuwe registratie wordt de geldigheid van de opleiding gebruikt als je geen vervaldatum invult.</p>` +
        textarea(
          "Toelichting",
          "note",
          item?.note || "",
          'rows="3" maxlength="2000"',
        ),
      submit: async (values) => {
        const { expires_on, ...body } = values;
        if (expires_on || id) body.expires_on = expires_on || null;
        await api(
          `/api/workspace/completions${id ? `/${encodeURIComponent(id)}` : ""}`,
          { method: id ? "PUT" : "POST", body },
        );
        toast("Afronding geregistreerd.");
      },
    });
  }
  async function newRequest() {
    await openForm({
      title: "Nieuwe aanvraag",
      key: "request-new",
      label: "Aanvraag indienen",
      html:
        select(
          "Type aanvraag",
          "type",
          Object.entries(requestTypes).map(([id, label]) => ({ id, label })),
          "leave",
        ) +
        select(
          "Dienst",
          "service",
          availableServices().map((key) => ({
            id: key,
            label: services[key] || key,
          })),
          me.permissions?.policeRead
            ? "police"
            : me.permissions?.ambulance
              ? "ambulance"
              : "shared",
        ) +
        input(
          "Onderwerp",
          "title",
          "",
          'required maxlength="160" placeholder="Waar gaat je aanvraag over?"',
        ) +
        textarea(
          "Toelichting",
          "description",
          "",
          'required rows="4" maxlength="6000" placeholder="Beschrijf wat je aanvraagt en waarom."',
        ) +
        `<div class="ws-request-dates ws-form-columns">${input("Vanaf", "start_date", "", 'type="date"')}${input("Tot en met", "end_date", "", 'type="date"')}</div><p class="ws-muted">Bij verlof zijn beide datums verplicht; bij andere aanvragen zijn ze optioneel.</p><div class="ws-request-course">${select("Opleiding", "course_id", [{ id: "", label: "Selecteer een opleiding (optioneel)" }, ...(data.courses || []).filter((course) => course.active).map((course) => ({ id: course.id, label: course.name }))], "")}</div>`,
      afterFill(form) {
        form.querySelector(".ws-request-course").hidden =
          form.elements.type.value !== "training";
        form.elements.start_date.required = form.elements.end_date.required =
          form.elements.type.value === "leave";
      },
      submit: async (values) => {
        if (
          values.start_date &&
          values.end_date &&
          values.end_date < values.start_date
        )
          throw Error("De einddatum mag niet vóór de begindatum liggen.");
        await api("/api/workspace/requests", {
          method: "POST",
          body: {
            ...values,
            start_date: values.start_date || null,
            end_date: values.end_date || null,
            course_id:
              values.type === "training" ? values.course_id || null : null,
          },
        });
        toast("Je aanvraag is ingediend.");
      },
    });
  }
  async function reviewRequest(id) {
    const item = (data.requests || []).find(
      (entry) => String(entry.id) === String(id),
    );
    if (!item) return;
    await openForm({
      title: "Aanvraag beoordelen",
      key: `review-${id}`,
      label: "Beoordeling opslaan",
      html: `<div class="ws-review-summary"><span class="ws-muted">${e(item.username)} · ${e(requestTypes[item.type])}</span><h3>${e(item.title)}</h3><p>${e(item.description)}</p></div>${select(
        "Besluit",
        "status",
        [
          { id: "approved", label: "Goedkeuren" },
          { id: "rejected", label: "Afwijzen" },
        ],
        "approved",
      )}${textarea("Toelichting voor de medewerker", "reason", "", 'required rows="4" maxlength="3000"')}`,
      submit: async (values) => {
        await api(`/api/workspace/requests/${encodeURIComponent(id)}/review`, {
          method: "PUT",
          body: values,
        });
        toast("Beoordeling opgeslagen.");
      },
    });
  }
  function confirmDelete(kind, id) {
    const item = (
      kind === "folders"
        ? folders()
        : kind === "documents"
          ? documents()
          : data.completions || []
    ).find((entry) => String(entry.id) === String(id));
    if (!item) return;
    showDialog(
      "Verwijderen bevestigen",
      `<p>Wil je <strong>${e(item.name || item.title || `${item.person_name} · ${item.course_name}`)}</strong> verwijderen?</p><p class="ws-muted">${kind === "folders" ? "Alleen lege mappen kunnen worden verwijderd." : "Deze actie verwijdert dit item voor iedereen die toegang heeft."}</p>`,
      {
        footer: `<button type="button" data-ws="close-dialog">Annuleren</button><button type="button" class="ws-danger ws-delete-confirm" data-ws="confirm-delete" data-kind="${kind}" ${idAttr(id)}>Verwijderen</button>`,
      },
    );
  }
  async function handleClick(event) {
    const target = event.target.closest("[data-ws]");
    if (!target || !host.contains(target) || target.disabled) return;
    const action = target.dataset.ws,
      id = target.dataset.id;
    try {
      if (action === "close-dialog") return closeDialog();
      if (action === "view") {
        view = target.dataset.view;
        query = "";
        selected = null;
        paint();
        return;
      }
      if (action === "service") {
        service = target.dataset.service;
        setFolder(null);
        return;
      }
      if (action === "folder") return setFolder(id);
      if (action === "home") {
        service = "all";
        return setFolder(null);
      }
      if (action === "up") return setFolder(folder(folderId)?.parent_id);
      if (action === "layout") {
        layout = layout === "list" ? "grid" : "list";
        return paint();
      }
      if (action === "refresh") return refresh();
      if (action === "select-document") {
        if (String(selected) === String(id)) return openDocument(id);
        selected = id;
        return paint();
      }
      if (action === "clear-selection") {
        selected = null;
        return paint();
      }
      if (action === "new-folder" || action === "edit-folder")
        return editFolder(id);
      if (action === "new-document") return chooseTemplate();
      if (action === "use-template")
        return editDocument(null, target.dataset.template);
      if (action === "open-document") return openDocument(id);
      if (action === "edit-document") {
        const item = documents().find(
          (entry) => String(entry.id) === String(id),
        );
        return item?.kind === "file"
          ? editFileMetadata(item)
          : editDocument(id);
      }
      if (action === "delete-document") return confirmDelete("documents", id);
      if (action === "delete-folder") return confirmDelete("folders", id);
      if (action === "delete-completion")
        return confirmDelete("completions", id);
      if (action === "confirm-delete") {
        target.disabled = true;
        await api(
          `/api/workspace/${target.dataset.kind}/${encodeURIComponent(id)}`,
          { method: "DELETE" },
        );
        currentForm = null;
        dialog.close();
        toast("Item verwijderd.");
        await refresh();
        onChange();
        return;
      }
      if (action === "upload")
        return shell.querySelector("#ws-upload-input")?.click();
      if (action === "new-course" || action === "edit-course")
        return editCourse(id);
      if (action === "new-completion" || action === "edit-completion")
        return editCompletion(id);
      if (action === "new-request") return newRequest();
      if (action === "review-request") return reviewRequest(id);
      if (action === "print-document") {
        dialog.classList.add("ws-print-active");
        window.print();
        dialog.classList.remove("ws-print-active");
      }
    } catch (error) {
      if (!destroyed) {
        toast(error.message, true);
        target.disabled = false;
      }
    }
  }
  function handleSearch(event) {
    if (
      !["ws-file-search", "ws-training-search", "ws-request-search"].includes(
        event.target.id,
      )
    )
      return;
    query = event.target.value;
    clearTimeout(fileSearchTimer);
    const id = event.target.id,
      start = event.target.selectionStart;
    fileSearchTimer = setTimeout(() => {
      if (destroyed) return;
      paint();
      const next = shell.querySelector(`#${id}`);
      next?.focus();
      if (next?.setSelectionRange) next.setSelectionRange(start, start);
    }, 180);
  }
  function handleDoubleClick(event) {
    const target = event.target.closest('[data-ws="select-document"]');
    if (target) openDocument(target.dataset.id);
  }
  function handleKey(event) {
    const item = event.target.closest("tr[data-ws]");
    if (item && ["Enter", " "].includes(event.key)) {
      event.preventDefault();
      if (item.dataset.ws === "select-document" && event.key === "Enter")
        openDocument(item.dataset.id);
      else item.click();
    }
  }
  function unbind() {
    host?.removeEventListener("click", handleClick);
    host?.removeEventListener("input", handleSearch);
    host?.removeEventListener("keydown", handleKey);
    host?.removeEventListener("dblclick", handleDoubleClick);
  }
  function destroy() {
    if (currentForm?.dirty) saveDraft();
    destroyed = true;
    loading = false;
    requestVersion++;
    clearTimeout(draftTimer);
    clearTimeout(fileSearchTimer);
    unbind();
    if (dialog?.open) dialog.close();
    currentForm = null;
  }
  return { render, refresh, destroy, openDocument, navigate };
}
