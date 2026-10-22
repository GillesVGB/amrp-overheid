import fs from "node:fs";
import { getSettings, transaction, audit, timestamp } from "./database.mjs";
import { requireValue } from "./security.mjs";

export function maintenanceState(db) {
  const value = getSettings(db).maintenance;
  return {
    enabled: value?.enabled === true,
    reason: value?.enabled === true ? String(value.reason || "") : "",
    updatedAt: value?.updatedAt || null,
  };
}

export function maintenanceHeaders(res, state) {
  res.set("Cache-Control", "no-store");
  res.set("X-AMRP-Maintenance", "1");
  res.set("X-AMRP-Maintenance-Reason", encodeURIComponent(state.reason));
  res.set("Retry-After", "60");
}

export function blockForMaintenance(req, res, state) {
  maintenanceHeaders(res, state);
  return res
    .status(503)
    .json({
      code: "SITE_MAINTENANCE",
      error: "Het overheidsportaal is tijdelijk in onderhoud.",
      maintenance: state,
    });
}

export function installMaintenance(app, { db, auth }) {
  const html = () =>
    fs.readFileSync(
      new URL("../public/onderhoud.html", import.meta.url),
      "utf8",
    );
  app.get("/api/site-status", (_req, res) =>
    res
      .set("Cache-Control", "no-store")
      .json({ maintenance: maintenanceState(db) }),
  );
  app.put(
    "/api/maintenance",
    auth.auth,
    auth.csrf,
    auth.permit("settings"),
    (req, res) => {
      requireValue(
        typeof req.body.enabled === "boolean",
        400,
        "Kies of onderhoud aan of uit moet staan.",
      );
      const reason = String(req.body.reason || "").trim();
      requireValue(
        reason.length <= 500 && (!req.body.enabled || reason.length >= 5),
        400,
        "Vul een onderhoudsreden in van 5 tot 500 tekens.",
      );
      const next = {
        enabled: req.body.enabled,
        reason: req.body.enabled ? reason : "",
        updatedAt: timestamp(),
      };
      transaction(db, () => {
        const settings = getSettings(db);
        db.prepare("UPDATE settings SET value=? WHERE id=1").run(
          JSON.stringify({ ...settings, maintenance: next }),
        );
        audit(
          db,
          req.auth.user,
          next.enabled
            ? "systeem.onderhoud_ingeschakeld"
            : "systeem.onderhoud_beeindigd",
          "onderhoud",
          settings.maintenance || { enabled: false },
          next,
        );
      });
      res.json({ ok: true, maintenance: next });
    },
  );
  app.get(
    ["/", "/index.html", "/login.html", "/admin", "/admin/"],
    (req, res, next) => {
      const state = maintenanceState(db);
      if (req.path.startsWith("/admin"))
        return res.redirect("/login.html?beheer=1");
      if (
        !state.enabled ||
        (req.path === "/login.html" && req.query.beheer === "1")
      )
        return next();
      auth.auth(req, res, (error) => {
        if (!error && req.auth?.grants.admin) return next();
        maintenanceHeaders(res, state);
        return res.status(503).type("html").send(html());
      });
    },
  );
}
