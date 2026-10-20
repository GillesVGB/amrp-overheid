// Drafts are private to the signed-in account; credentials and uploads are excluded.
export function bindDraft(form, key, { api, userId }) {
  if (form.querySelector('input[type="password"],input[type="file"]'))
    return { clear: async () => {}, destroy() {}, dirty: false };
  const storageKey = `amrp-draft:${userId}:${key}`;
  const endpoint = "/api/drafts/" + encodeURIComponent(key);
  let touched = false,
    dead = false,
    timer,
    saved = null,
    pending = Promise.resolve();
  const banner = document.createElement("div");
  banner.className = "form-draft-status";
  banner.setAttribute("role", "status");
  form.append(banner);
  function values() {
    const result = {};
    for (const field of form.elements)
      if (
        field.name &&
        !field.disabled &&
        !["submit", "button", "password", "file"].includes(field.type)
      )
        result[field.name] =
          field.type === "checkbox" ? field.checked : field.value;
    return result;
  }
  function restore(value) {
    if (!value || typeof value !== "object" || dead || touched) return;
    for (const field of form.elements)
      if (field.name && Object.hasOwn(value, field.name)) {
        if (field.type === "checkbox")
          field.checked = value[field.name] === true;
        else if (!["password", "file", "submit", "button"].includes(field.type))
          field.value = String(value[field.name] ?? "");
      }
    saved = value;
    banner.textContent = "Je bewaarde concept is hersteld. ";
    const discard = document.createElement("button");
    discard.type = "button";
    discard.textContent = "Concept wissen";
    discard.className = "button secondary";
    discard.onclick = async () => {
      await clear();
      form.reset();
      banner.textContent = "Concept gewist.";
    };
    banner.append(discard);
  }
  try {
    restore(JSON.parse(localStorage.getItem(storageKey) || "null"));
  } catch {
    /* Server copy remains available. */
  }
  if (!saved)
    api(endpoint)
      .then((result) => restore(result.value))
      .catch(() => {});
  function persist() {
    const value = values();
    saved = value;
    try {
      localStorage.setItem(storageKey, JSON.stringify(value));
    } catch {
      /* Use server storage. */
    }
    pending = pending
      .catch(() => {})
      .then(() => api(endpoint, { method: "PUT", body: { value } }))
      .then(() => {
        if (!dead) banner.textContent = "Concept bewaard voor jouw account.";
      })
      .catch(() => {
        if (!dead)
          banner.textContent =
            "Concept op dit apparaat bewaard; synchronisatie volgt bij de volgende wijziging.";
      });
  }
  function change() {
    touched = true;
    clearTimeout(timer);
    timer = setTimeout(persist, 600);
  }
  form.addEventListener("input", change);
  form.addEventListener("change", change);
  async function clear() {
    clearTimeout(timer);
    touched = false;
    saved = null;
    try {
      localStorage.removeItem(storageKey);
    } catch {
      /* No browser storage. */
    }
    await pending;
    await api(endpoint, { method: "DELETE" }).catch(() => {});
    banner.textContent = "";
  }
  return {
    get dirty() {
      return touched;
    },
    clear,
    destroy() {
      clearTimeout(timer);
      if (touched) persist();
      dead = true;
      form.removeEventListener("input", change);
      form.removeEventListener("change", change);
      banner.remove();
    },
  };
}
