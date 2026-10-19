import express from "express";
import helmet from "helmet";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authentication } from "./auth.mjs";
import {
  openDatabase,
  getSettings,
  id,
  timestamp,
  audit,
  publicUser,
  listPersonnel,
  listCallsigns,
  savePersonnel,
  saveCallsign,
  saveRank,
  transaction,
  sqliteError,
} from "./database.mjs";
import {
  HttpError,
  requireValue,
  text,
  snowflake,
  hashPassword,
  verifyPassword,
  detectFile,
  permissions,
} from "./security.mjs";
import { createDiscordSync } from "./discord-sync.mjs";
const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
export async function createApp(config, options = {}) {
  const db = options.db || openDatabase(config),
    app = express();
  app.disable("x-powered-by");
  if (config.production) app.set("trust proxy", 1);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", "blob:"],
          connectSrc: ["'self'"],
          fontSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'none'"],
          formAction: ["'self'"],
          upgradeInsecureRequests: config.production ? [] : null,
        },
      },
      hsts: config.production ? undefined : false,
    }),
  );
  app.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  app.use(express.json({ limit: "100kb" }));
  const auth = authentication({ db, config, ...options });
  auth.install(app);
  const roster = createDiscordSync({
    db,
    config,
    ...(options.discordRequest ? { request: options.discordRequest } : {}),
  });
  app.post("/api/password", auth.auth, auth.csrf, async (req, res) => {
    requireValue(
      await verifyPassword(
        req.body.currentPassword,
        req.auth.user.password_hash,
      ),
      400,
      "Je huidige wachtwoord klopt niet.",
    );
    requireValue(
      req.body.newPassword !== req.body.currentPassword,
      400,
      "Kies een ander wachtwoord.",
    );
    const hash = await hashPassword(req.body.newPassword);
    transaction(db, () => {
      db.prepare(
        "UPDATE users SET password_hash=?,must_change=0 WHERE id=?",
      ).run(hash, req.auth.user.id);
      db.prepare("DELETE FROM sessions WHERE user_id=? AND hash<>?").run(
        req.auth.user.id,
        req.auth.hash,
      );
      audit(
        db,
        req.auth.user,
        "account.wachtwoord_gewijzigd",
        req.auth.user.id,
      );
    });
    res.json({ ok: true });
  });
  const p = (name) => [auth.auth, auth.permit(name)];
  const w = (name) => [auth.auth, auth.csrf, auth.permit(name)];
  app.get("/api/ambulance/calls", ...p("ambulance"), (req, res) => {
    res.json({
      calls: db
        .prepare(
          "SELECT * FROM ambulance_calls ORDER BY CASE status WHEN 'Afgerond' THEN 1 ELSE 0 END, updated_at DESC LIMIT 200",
        )
        .all(),
    });
  });
  app.post("/api/ambulance/calls", ...w("ambulance"), (req, res) => {
    const body = req.body;
    requireValue(
      ["Regulier", "Spoed"].includes(body.priority),
      400,
      "Kies een geldige prioriteit.",
    );
    const call = {
      id: id(),
      call_number: "AMB-" + id().slice(0, 6).toUpperCase(),
      priority: body.priority,
      status: "Nieuw",
      location: text(body.location, "Locatie", 120),
      summary: text(body.summary, "Korte RP-melding", 500),
      unit: text(body.unit ?? "", "Eenheid", 60, true),
      created_by: req.auth.identity.username,
      created_at: timestamp(),
      updated_at: timestamp(),
    };
    transaction(db, () => {
      db.prepare("INSERT INTO ambulance_calls VALUES(?,?,?,?,?,?,?,?,?,?)").run(
        ...Object.values(call),
      );
      audit(
        db,
        req.auth.user,
        "ambulance.melding_toegevoegd",
        call.call_number,
        null,
        call,
      );
    });
    res.status(201).json(call);
  });
  app.put("/api/ambulance/calls/:id", ...w("ambulance"), (req, res) => {
    const before = db
      .prepare("SELECT * FROM ambulance_calls WHERE id=?")
      .get(req.params.id);
    requireValue(before, 404, "Melding niet gevonden.");
    const body = req.body;
    requireValue(
      ["Regulier", "Spoed"].includes(body.priority),
      400,
      "Kies een geldige prioriteit.",
    );
    requireValue(
      [
        "Nieuw",
        "Eenheid toegewezen",
        "Onderweg",
        "Ter plaatse",
        "Afgerond",
      ].includes(body.status),
      400,
      "Kies een geldige status.",
    );
    const next = {
      priority: body.priority,
      status: body.status,
      location: text(body.location, "Locatie", 120),
      summary: text(body.summary, "Korte RP-melding", 500),
      unit: text(body.unit ?? "", "Eenheid", 60, true),
      updated_at: timestamp(),
    };
    transaction(db, () => {
      db.prepare(
        "UPDATE ambulance_calls SET priority=?,status=?,location=?,summary=?,unit=?,updated_at=? WHERE id=?",
      ).run(
        next.priority,
        next.status,
        next.location,
        next.summary,
        next.unit,
        next.updated_at,
        before.id,
      );
      audit(
        db,
        req.auth.user,
        next.status === "Afgerond"
          ? "ambulance.melding_afgerond"
          : "ambulance.melding_gewijzigd",
        before.call_number,
        before,
        { ...before, ...next },
      );
    });
    res.json({ ...before, ...next });
  });
  app.get("/api/bootstrap", auth.auth, (req, res) => {
    requireValue(
      !req.auth.user.must_change,
      403,
      "Wijzig eerst je tijdelijke wachtwoord.",
    );
    const g = req.auth.grants;
    res.json({
      ranks:
        g.policeRead || g.ranks
          ? db.prepare("SELECT * FROM ranks ORDER BY position").all()
          : [],
      personnel: g.policeRead ? listPersonnel(db) : [],
      callsigns: g.policeRead ? listCallsigns(db) : [],
      categories: g.archive
        ? db.prepare("SELECT * FROM categories ORDER BY name").all()
        : [],
      archive: g.archive
        ? db
            .prepare(
              "SELECT id,title,category_id,description,note,filename,mime,size,created_at,updated_at,created_by FROM archive ORDER BY updated_at DESC",
            )
            .all()
        : [],
      accounts: g.accounts
        ? db
            .prepare("SELECT * FROM users ORDER BY username")
            .all()
            .map(publicUser)
        : [],
      audit: g.audit
        ? db.prepare("SELECT * FROM audit ORDER BY id DESC LIMIT 300").all()
        : [],
      settings: g.settings ? getSettings(db) : null,
      discord: g.policeRead ? roster.status() : null,
    });
  });
  app.get("/api/discord/roles", ...p("ranks"), async (req, res) =>
    res.json({ roles: await roster.roles() }),
  );
  app.post("/api/discord/sync", ...w("policeWrite"), async (req, res) => {
    auth.limit("roster-sync", 5, 60000);
    res.json(await roster.run(req.auth.user));
  });
  app.post("/api/personnel", ...w("policeWrite"), (req, res) =>
    res.status(201).json(savePersonnel(db, req.auth.user, req.body)),
  );
  app.put("/api/personnel/:id", ...w("policeWrite"), (req, res) =>
    res.json(savePersonnel(db, req.auth.user, req.body, req.params.id)),
  );
  app.delete("/api/personnel/:id", ...w("policeWrite"), (req, res) => {
    const row = db
      .prepare("SELECT * FROM personnel WHERE id=?")
      .get(req.params.id);
    requireValue(row, 404, "Personeelslid niet gevonden.");
    transaction(db, () => {
      db.prepare("UPDATE callsigns SET place='' WHERE personnel_id=?").run(
        row.id,
      );
      db.prepare("DELETE FROM personnel WHERE id=?").run(row.id);
      audit(db, req.auth.user, "personeel.verwijderd", row.id, row);
    });
    res.json({ ok: true });
  });
  app.post("/api/callsigns", ...w("policeWrite"), (req, res) =>
    res.status(201).json({ id: saveCallsign(db, req.auth.user, req.body) }),
  );
  app.put("/api/callsigns/:id", ...w("policeWrite"), (req, res) =>
    res.json({ id: saveCallsign(db, req.auth.user, req.body, req.params.id) }),
  );
  app.delete("/api/callsigns/:id", ...w("policeWrite"), (req, res) => {
    const row = db
      .prepare("SELECT * FROM callsigns WHERE id=?")
      .get(req.params.id);
    requireValue(row, 404, "Roepnummer niet gevonden.");
    requireValue(!row.personnel_id, 409, "Maak dit roepnummer eerst vrij.");
    transaction(db, () => {
      db.prepare("DELETE FROM callsigns WHERE id=?").run(row.id);
      audit(db, req.auth.user, "roepnummer.verwijderd", row.id, row);
    });
    res.json({ ok: true });
  });
  app.post("/api/ranks", ...w("ranks"), (req, res) =>
    res.status(201).json(saveRank(db, req.auth.user, req.body)),
  );
  app.put("/api/ranks/:id", ...w("ranks"), (req, res) =>
    res.json(saveRank(db, req.auth.user, req.body, req.params.id)),
  );
  app.delete("/api/ranks/:id", ...w("ranks"), (req, res) => {
    const row = db.prepare("SELECT * FROM ranks WHERE id=?").get(req.params.id);
    requireValue(row, 404, "Rang bestaat niet.");
    requireValue(
      !db.prepare("SELECT id FROM personnel WHERE rank_id=?").get(row.id),
      409,
      "Verplaats eerst het personeel met deze rang.",
    );
    transaction(db, () => {
      db.prepare("DELETE FROM ranks WHERE id=?").run(row.id);
      audit(db, req.auth.user, "rang.verwijderd", row.id, row);
    });
    res.json({ ok: true });
  });
  app.get("/api/callsigns.csv", ...p("policeWrite"), (req, res) => {
    const cell = (value) => {
      let s = String(value ?? "");
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return '"' + s.replaceAll('"', '""') + '"';
    };
    const lines = [
      ["Roepnummer", "Discord-naam", "Plaats", "Rang"],
      ...listCallsigns(db).map((x) => [
        x.number,
        x.discord_name,
        x.place,
        x.rank,
      ]),
    ];
    res
      .type("text/csv")
      .attachment("roepnummers.csv")
      .send("\ufeff" + lines.map((x) => x.map(cell).join(";")).join("\r\n"));
    audit(db, req.auth.user, "roepnummer.export", "alle");
  });
  app.post("/api/categories", ...w("archive"), (req, res) => {
    const row = { id: id(), name: text(req.body.name, "Categorienaam", 80) };
    transaction(db, () => {
      db.prepare("INSERT INTO categories VALUES(?,?)").run(row.id, row.name);
      audit(db, req.auth.user, "categorie.toegevoegd", row.id, null, row);
    });
    res.status(201).json(row);
  });
  app.put("/api/categories/:id", ...w("archive"), (req, res) => {
    const before = db
      .prepare("SELECT * FROM categories WHERE id=?")
      .get(req.params.id);
    requireValue(before, 404, "Categorie niet gevonden.");
    const name = text(req.body.name, "Categorienaam", 80);
    transaction(db, () => {
      db.prepare("UPDATE categories SET name=? WHERE id=?").run(
        name,
        before.id,
      );
      audit(db, req.auth.user, "categorie.gewijzigd", before.id, before, {
        name,
      });
    });
    res.json({ ok: true });
  });
  app.delete("/api/categories/:id", ...w("archive"), (req, res) => {
    const row = db
      .prepare("SELECT * FROM categories WHERE id=?")
      .get(req.params.id);
    requireValue(row, 404, "Categorie niet gevonden.");
    requireValue(
      !db.prepare("SELECT id FROM archive WHERE category_id=?").get(row.id),
      409,
      "Verplaats of verwijder eerst de archiefitems in deze categorie.",
    );
    transaction(db, () => {
      db.prepare("DELETE FROM categories WHERE id=?").run(row.id);
      audit(db, req.auth.user, "categorie.verwijderd", row.id, row);
    });
    res.json({ ok: true });
  });
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: 5 * 1024 * 1024,
      files: 1,
      fields: 6,
      fieldSize: 30000,
    },
  }).single("file");
  const uploadDir = path.join(config.dataDir, "uploads");
  fs.mkdirSync(uploadDir, { recursive: true });
  const saveArchive = (req, res) => {
    const before = req.params.id
      ? db.prepare("SELECT * FROM archive WHERE id=?").get(req.params.id)
      : null;
    requireValue(!req.params.id || before, 404, "Archiefitem niet gevonden.");
    const row = {
      id: before?.id || id(),
      title: text(req.body.title, "Titel", 160),
      categoryId: text(req.body.categoryId, "Categorie", 40),
      description: text(req.body.description ?? "", "Beschrijving", 1000, true),
      note: text(req.body.note ?? "", "Notitie", 25000, true),
    };
    requireValue(
      db.prepare("SELECT id FROM categories WHERE id=?").get(row.categoryId),
      400,
      "Kies een bestaande categorie.",
    );
    let stored = null;
    try {
      if (req.file) {
        requireValue(req.file.size > 0, 400, "Het bestand is leeg.");
        const detected = detectFile(req.file.buffer);
        stored = {
          storageName: id() + detected.ext,
          mime: detected.mime,
          size: req.file.size,
          filename: text(
            path.basename(req.file.originalname.replaceAll("\\", "/")),
            "Bestandsnaam",
            180,
          ),
        };
        fs.writeFileSync(
          path.join(uploadDir, stored.storageName),
          req.file.buffer,
          { flag: "wx", mode: 0o600 },
        );
      }
      requireValue(
        row.note || stored || before?.storage_name,
        400,
        "Schrijf een notitie of kies een bestand.",
      );
      transaction(db, () => {
        if (before)
          db.prepare(
            "UPDATE archive SET title=?,category_id=?,description=?,note=?,filename=?,mime=?,size=?,storage_name=?,updated_at=? WHERE id=?",
          ).run(
            row.title,
            row.categoryId,
            row.description,
            row.note,
            stored?.filename || before.filename,
            stored?.mime || before.mime,
            stored?.size || before.size,
            stored?.storageName || before.storage_name,
            timestamp(),
            row.id,
          );
        else
          db.prepare("INSERT INTO archive VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(
            row.id,
            row.title,
            row.categoryId,
            row.description,
            row.note,
            stored?.filename || null,
            stored?.mime || null,
            stored?.size || 0,
            stored?.storageName || null,
            req.auth.user.id,
            timestamp(),
            timestamp(),
          );
        audit(
          db,
          req.auth.user,
          before ? "archief.gewijzigd" : "archief.toegevoegd",
          row.id,
          before ? { title: before.title, category: before.category_id } : null,
          { ...row, filename: stored?.filename || before?.filename || null },
        );
      });
    } catch (error) {
      if (stored)
        fs.rmSync(path.join(uploadDir, stored.storageName), { force: true });
      throw error;
    }
    if (stored && before?.storage_name)
      fs.rmSync(path.join(uploadDir, before.storage_name), { force: true });
    res.status(before ? 200 : 201).json({ id: row.id });
  };
  app.post("/api/archive", ...w("archive"), upload, saveArchive);
  app.put("/api/archive/:id", ...w("archive"), upload, saveArchive);
  app.get("/api/archive/:id/file", ...p("archive"), (req, res) => {
    const row = db
      .prepare("SELECT * FROM archive WHERE id=?")
      .get(req.params.id);
    requireValue(row?.storage_name, 404, "Bestand niet gevonden.");
    res.set("Content-Security-Policy", "default-src 'none'; sandbox");
    res.type(row.mime);
    if (req.query.preview === "1" && row.mime.startsWith("image/"))
      res.set("Content-Disposition", "inline");
    else res.attachment(row.filename);
    res.sendFile(path.join(uploadDir, row.storage_name));
  });
  app.delete("/api/archive/:id", ...w("archive"), (req, res) => {
    const row = db
      .prepare("SELECT * FROM archive WHERE id=?")
      .get(req.params.id);
    requireValue(row, 404, "Archiefitem niet gevonden.");
    transaction(db, () => {
      db.prepare("DELETE FROM archive WHERE id=?").run(row.id);
      audit(db, req.auth.user, "archief.verwijderd", row.id, {
        title: row.title,
        filename: row.filename,
      });
    });
    if (row.storage_name)
      fs.rmSync(path.join(uploadDir, row.storage_name), { force: true });
    res.json({ ok: true });
  });
  app.post("/api/accounts", ...w("accounts"), async (req, res) => {
    const username = text(
      req.body.username,
      "Gebruikersnaam",
      80,
    ).toLowerCase();
    requireValue(
      /^[\p{L}\p{N}._-]+$/u.test(username),
      400,
      "Gebruik alleen letters, cijfers, punten, streepjes en underscores.",
    );
    const discordId = snowflake(req.body.discordId),
      hash = await hashPassword(req.body.password),
      target = id();
    transaction(db, () => {
      db.prepare("INSERT INTO users VALUES(?,?,?,?,1,1,?)").run(
        target,
        username,
        discordId,
        hash,
        timestamp(),
      );
      audit(db, req.auth.user, "account.toegevoegd", target, null, {
        username,
        discordId,
      });
    });
    res.status(201).json({ id: target });
  });
  app.put("/api/accounts/:id", ...w("accounts"), async (req, res) => {
    const before = db
      .prepare("SELECT * FROM users WHERE id=?")
      .get(req.params.id);
    requireValue(before, 404, "Account niet gevonden.");
    requireValue(
      before.id !== req.auth.user.id || req.body.enabled !== false,
      400,
      "Je kunt je eigen account niet uitschakelen.",
    );
    const hash = req.body.password
      ? await hashPassword(req.body.password)
      : null;
    transaction(db, () => {
      db.prepare(
        "UPDATE users SET enabled=?,password_hash=?,must_change=? WHERE id=?",
      ).run(
        req.body.enabled === false ? 0 : 1,
        hash || before.password_hash,
        hash ? 1 : before.must_change,
        before.id,
      );
      db.prepare("DELETE FROM sessions WHERE user_id=?").run(before.id);
      audit(
        db,
        req.auth.user,
        hash ? "account.wachtwoord_hersteld" : "account.toegang_gewijzigd",
        before.id,
        { enabled: Boolean(before.enabled) },
        { enabled: req.body.enabled !== false },
      );
    });
    res.json({ ok: true });
  });
  app.delete("/api/accounts/:id", ...w("accounts"), (req, res) => {
    const row = db.prepare("SELECT * FROM users WHERE id=?").get(req.params.id);
    requireValue(row, 404, "Account niet gevonden.");
    requireValue(
      row.id !== req.auth.user.id,
      400,
      "Je kunt je eigen account niet verwijderen.",
    );
    transaction(db, () => {
      db.prepare("DELETE FROM users WHERE id=?").run(row.id);
      audit(db, req.auth.user, "account.verwijderd", row.id, publicUser(row));
    });
    res.json({ ok: true });
  });
  app.put("/api/settings", ...w("settings"), (req, res) => {
    const before = getSettings(db),
      body = req.body,
      next = {
        name: text(body.name, "Omgevingsnaam", 80),
        roles: {},
        grants: {},
        ambulanceEnabled: body.ambulanceEnabled === true,
      };
    for (const key of ["admin", "police", "command", "ambulance"]) {
      requireValue(
        Array.isArray(body.roles?.[key]) && body.roles[key].length <= 20,
        400,
        "Ongeldige rollenconfiguratie.",
      );
      next.roles[key] = [
        ...new Set(body.roles[key].map((x) => snowflake(x, "Rol-ID"))),
      ];
    }
    requireValue(
      req.auth.grants.owner ||
        (next.roles.admin.length &&
          next.roles.admin.some((x) => req.auth.roles.includes(x))),
      400,
      "Behoud minstens één beheerrol die je zelf hebt.",
    );
    requireValue(
      !next.roles.command.some((x) => next.roles.police.includes(x)),
      400,
      "Agent en Korpsleiding moeten verschillende rollen hebben.",
    );
    for (const key of ["policeRead", "policeWrite", "archive", "audit"]) {
      requireValue(
        Array.isArray(body.grants?.[key]) && body.grants[key].length <= 20,
        400,
        "Ongeldige extra rechten.",
      );
      next.grants[key] = body.grants[key].map((x) => snowflake(x, "Rol-ID"));
    }
    transaction(db, () => {
      db.prepare("UPDATE settings SET value=? WHERE id=1").run(
        JSON.stringify(next),
      );
      audit(
        db,
        req.auth.user,
        "systeem.ingesteld",
        "instellingen",
        before,
        next,
      );
    });
    res.json({ ok: true });
  });
  app.use("/api", (req, res) =>
    res.status(404).json({ error: "Dit API-adres bestaat niet." }),
  );
  app.use(
    express.static(publicDir, {
      index: "index.html",
      dotfiles: "deny",
      etag: false,
    }),
  );
  app.use((req, res) =>
    res.status(404).type("text").send("Pagina niet gevonden."),
  );
  app.use((original, req, res, next) => {
    const error = sqliteError(original);
    const status =
      error instanceof multer.MulterError
        ? error.code === "LIMIT_FILE_SIZE"
          ? 413
          : 400
        : error.status || (error.type === "entity.too.large" ? 413 : 500);
    if (status >= 500 && !error.status)
      console.error("Verzoek mislukt:", error.code || error.name);
    res.status(status).json({
      error:
        error instanceof multer.MulterError
          ? "Upload geweigerd: maximaal één bestand van 5 MB."
          : status < 500 || error.status
            ? error.message
            : "Er ging iets mis. Probeer het opnieuw.",
    });
  });
  const cleanup = setInterval(() => {
    const now = Date.now();
    db.prepare("DELETE FROM auth_flows WHERE expires_at<?").run(now);
    db.prepare("DELETE FROM sessions WHERE expires_at<?").run(now);
    db.prepare("DELETE FROM rate_limits WHERE expires_at<?").run(now);
  }, 300000);
  cleanup.unref();
  const syncTimer =
    config.botToken && !config.demo && !options.discord
      ? setInterval(() => roster.run().catch(() => {}), 300000)
      : null;
  if (syncTimer) {
    syncTimer.unref();
    roster
      .run()
      .catch(() =>
        console.error("Discord-synchronisatie kon nog niet worden voltooid."),
      );
  }
  return {
    app,
    db,
    roster,
    close() {
      clearInterval(cleanup);
      if (syncTimer) clearInterval(syncTimer);
      db.close();
    },
  };
}
