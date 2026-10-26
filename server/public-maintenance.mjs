function publicMaintenance(value) {
  const settings = typeof value === "string" ? JSON.parse(value) : value;
  if (!settings || typeof settings !== "object" || Array.isArray(settings))
    throw new Error("De opgeslagen portaalinstellingen zijn ongeldig.");
  const state = settings.maintenance;
  if (
    state != null &&
    (typeof state !== "object" ||
      Array.isArray(state) ||
      typeof state.enabled !== "boolean")
  )
    throw new Error("De opgeslagen onderhoudsinstellingen zijn ongeldig.");
  return { maintenance: effectiveMaintenance(settings) };
}

// Public status polling needs one committed settings row, not a full portal
// transaction. Before the relational migration, use the existing safe path.
export async function readPublicMaintenance(pool, fallback) {
  let result;
  try {
    result = await pool.query(
      "SELECT s.value FROM public.settings s WHERE s.id=1 AND EXISTS (SELECT 1 FROM public.amrp_portal_meta WHERE id=1)",
    );
  } catch (error) {
    if (error.code === "42P01") return fallback();
    throw error;
  }
  if (!result.rows.length) return fallback();
  return publicMaintenance(result.rows[0].value);
}
import { effectiveMaintenance } from "./maintenance-state.mjs";
