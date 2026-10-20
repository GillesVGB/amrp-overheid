import multer from "multer";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import {
  audit,
  id,
  timestamp,
  transaction,
  listPersonnel,
  listCallsigns,
} from "./database.mjs";
import {
  HttpError,
  requireValue,
  text,
  detectFile,
  positive,
} from "./security.mjs";

export const documentTemplates = [
  {
    key: "rapport",
    name: "Rapport",
    description: "Een vaste indeling voor een incident of bevinding.",
    fields: [
      {
        key: "datum",
        label: "Datum en tijd",
        type: "datetime-local",
        required: true,
      },
      { key: "locatie", label: "Locatie", type: "text", required: true },
      {
        key: "betrokkenen",
        label: "Betrokkenen",
        type: "textarea",
        required: false,
      },
      {
        key: "bevindingen",
        label: "Bevindingen",
        type: "textarea",
        required: true,
      },
      {
        key: "afhandeling",
        label: "Afhandeling",
        type: "textarea",
        required: false,
      },
    ],
    content: "Rapport",
  },
  {
    key: "aanvraag",
    name: "Aanvraag",
    description: "Een onderbouwde aanvraag met gewenste afhandeling.",
    fields: [
      { key: "onderwerp", label: "Onderwerp", type: "text", required: true },
      {
        key: "toelichting",
        label: "Toelichting",
        type: "textarea",
        required: true,
      },
      {
        key: "gewenste_datum",
        label: "Gewenste datum",
        type: "date",
        required: false,
      },
      {
        key: "benodigd",
        label: "Benodigd materiaal of ondersteuning",
        type: "textarea",
        required: false,
      },
    ],
    content: "Aanvraag",
  },
  {
    key: "dienstverslag",
    name: "Dienstverslag",
    description: "Leg de dienst, werkzaamheden en overdracht vast.",
    fields: [
      { key: "datum", label: "Datum", type: "date", required: true },
      {
        key: "eenheid",
        label: "Eenheid / roepnummer",
        type: "text",
        required: true,
      },
      { key: "collegas", label: "Collega’s", type: "text", required: false },
      {
        key: "werkzaamheden",
        label: "Werkzaamheden en bijzonderheden",
        type: "textarea",
        required: true,
      },
      {
        key: "overdracht",
        label: "Overdracht",
        type: "textarea",
        required: false,
      },
    ],
    content: "Dienstverslag",
  },
];

const services = ["shared", "police", "ambulance"];
const optional = (value, label, max = 1000) =>
  text(value ?? "", label, max, true);
const safeJson = (value, fallback = {}) => {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};
const manager = (req) =>
  Boolean(
    req.auth.grants.owner ||
    req.auth.grants.admin ||
    req.auth.grants.ranks ||
    req.auth.grants.policeWrite,
  );
function allowedServices(req) {
  const g = req.auth.grants;
  return [
    "shared",
    ...(g.owner || g.admin || g.policeRead || g.archive ? ["police"] : []),
    ...(g.owner || g.admin || g.ambulance ? ["ambulance"] : []),
  ];
}
function serviceAllowed(req, service) {
  return allowedServices(req).includes(service);
}
function assertService(req, service) {
  requireValue(
    serviceAllowed(req, service),
    403,
    "Je hebt geen toegang tot deze afdeling.",
  );
}
function assertManager(req) {
  requireValue(
    manager(req),
    403,
    "Alleen leiding of beheer kan dit aanpassen.",
  );
}
function date(value, label, required = false) {
  if (!value && !required) return null;
  const result = text(value, label, 10);
  const parsed = new Date(`${result}T00:00:00Z`);
  requireValue(
    /^\d{4}-\d{2}-\d{2}$/.test(result) &&
      Number.isFinite(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === result,
    400,
    label + " is ongeldig.",
  );
  return result;
}
function cleanFields(value, template) {
  requireValue(
    value && typeof value === "object" && !Array.isArray(value),
    400,
    "De documentvelden zijn ongeldig.",
  );
  requireValue(Object.keys(value).length <= 30, 400, "Te veel documentvelden.");
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    requireValue(
      /^[\p{L}\p{N}_-]{1,60}$/u.test(key),
      400,
      "Een documentveld is ongeldig.",
    );
    result[key] = text(entry, key, 12000, true);
  }
  if (template)
    for (const field of template.fields)
      requireValue(
        !field.required || result[field.key]?.trim(),
        400,
        `${field.label} ontbreekt.`,
      );
  requireValue(
    Buffer.byteLength(JSON.stringify(result)) <= 60000,
    400,
    "Het document is te groot.",
  );
  return result;
}

// Office Open XML is accepted only after its ZIP directory and content types are inspected.
// Archives are never extracted to disk and active/macro content is not accepted.
function officeFile(buffer, filename) {
  const ext = path.extname(filename).toLowerCase();
  if (![".docx", ".xlsx", ".pptx"].includes(ext)) return null;
  requireValue(
    buffer.readUInt32LE(0) === 0x04034b50,
    400,
    "Het Office-bestand is ongeldig.",
  );
  let end = -1;
  for (
    let offset = buffer.length - 22;
    offset >= Math.max(0, buffer.length - 65557);
    offset--
  ) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      end = offset;
      break;
    }
  }
  requireValue(end >= 0, 400, "Het Office-bestand is ongeldig.");
  requireValue(
    buffer.readUInt16LE(end + 4) === 0 && buffer.readUInt16LE(end + 6) === 0,
    400,
    "Een opgesplitst archief is niet toegestaan.",
  );
  const count = buffer.readUInt16LE(end + 10),
    names = [],
    entries = [];
  requireValue(
    count > 0 && count <= 2000,
    400,
    "Het Office-bestand bevat te veel onderdelen.",
  );
  let position = buffer.readUInt32LE(end + 16),
    unpacked = 0;
  for (let n = 0; n < count; n++) {
    requireValue(
      position + 46 <= end && buffer.readUInt32LE(position) === 0x02014b50,
      400,
      "Het Office-bestand is beschadigd.",
    );
    const flags = buffer.readUInt16LE(position + 8),
      method = buffer.readUInt16LE(position + 10),
      compressed = buffer.readUInt32LE(position + 20),
      size = buffer.readUInt32LE(position + 24);
    const length = buffer.readUInt16LE(position + 28),
      extra = buffer.readUInt16LE(position + 30),
      comment = buffer.readUInt16LE(position + 32),
      local = buffer.readUInt32LE(position + 42);
    requireValue(
      !(flags & 1) &&
        [0, 8].includes(method) &&
        position + 46 + length + extra + comment <= end,
      400,
      "Versleutelde of ongeldige Office-bestanden zijn niet toegestaan.",
    );
    const name = buffer
      .subarray(position + 46, position + 46 + length)
      .toString("utf8");
    requireValue(
      !name.includes("..") &&
        !name.includes("\\") &&
        !name.startsWith("/") &&
        !/(?:vbaproject|activex|embeddings\/)/i.test(name),
      400,
      "Office-bestanden met actieve inhoud zijn niet toegestaan.",
    );
    unpacked += size;
    requireValue(
      unpacked <= 40 * 1024 * 1024,
      400,
      "Het uitgepakte Office-bestand is te groot.",
    );
    names.push(name);
    entries.push({ name, local, size, compressed, method });
    position += 46 + length + extra + comment;
  }
  const main = {
    ".docx": "word/document.xml",
    ".xlsx": "xl/workbook.xml",
    ".pptx": "ppt/presentation.xml",
  }[ext];
  requireValue(
    names.includes("[Content_Types].xml") && names.includes(main),
    400,
    "Dit is geen geldig Office-document.",
  );
  const types = entries.find((x) => x.name === "[Content_Types].xml");
  requireValue(
    types.size <= 150000 &&
      types.local + 30 <= buffer.length &&
      buffer.readUInt32LE(types.local) === 0x04034b50,
    400,
    "Het Office-bestand is ongeldig.",
  );
  const start =
    types.local +
    30 +
    buffer.readUInt16LE(types.local + 26) +
    buffer.readUInt16LE(types.local + 28);
  requireValue(
    start + types.compressed <= buffer.length,
    400,
    "Het Office-bestand is beschadigd.",
  );
  let xml;
  try {
    const data = buffer.subarray(start, start + types.compressed);
    xml = (
      types.method === 8
        ? inflateRawSync(data, { maxOutputLength: 150000 })
        : data
    ).toString("utf8");
  } catch {
    throw new HttpError(400, "Het Office-bestand is beschadigd.");
  }
  requireValue(
    !/(?:macroEnabled|vbaProject|activeX|application\/x-msdownload)/i.test(xml),
    400,
    "Office-bestanden met macro’s zijn niet toegestaan.",
  );
  return {
    ext,
    mime: {
      ".docx":
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ".xlsx":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ".pptx":
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    }[ext],
  };
}
export function detectWorkspaceFile(buffer, filename) {
  requireValue(buffer.length > 0, 400, "Het bestand is leeg.");
  if (
    [".docx", ".xlsx", ".pptx"].includes(path.extname(filename).toLowerCase())
  ) {
    requireValue(buffer.length >= 30, 400, "Het Office-bestand is ongeldig.");
    return officeFile(buffer, filename);
  }
  return detectFile(buffer);
}

export function installWorkspace(app, { db, auth, archiveFiles }) {
  const secure = [
    auth.auth,
    (req, res, next) => {
      try {
        requireValue(
          !req.auth.user.must_change,
          403,
          "Wijzig eerst je tijdelijke wachtwoord.",
        );
        const g = req.auth.grants;
        requireValue(
          g.owner ||
            g.admin ||
            g.policeRead ||
            g.policeWrite ||
            g.ranks ||
            g.ambulance ||
            g.archive,
          403,
          "Je hebt geen toegang tot deze werkplek.",
        );
        next();
      } catch (error) {
        next(error);
      }
    },
  ];
  const write = [...secure, auth.csrf];
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: 4 * 1024 * 1024,
      files: 1,
      fields: 8,
      fieldSize: 65000,
    },
  }).single("file");
  const getFolder = (req, folderId) => {
    const folder = db
      .prepare("SELECT * FROM workspace_folders WHERE id=?")
      .get(folderId);
    requireValue(folder, 404, "Map niet gevonden.");
    assertService(req, folder.service);
    return folder;
  };
  const foldersFor = (req) =>
    db
      .prepare("SELECT * FROM workspace_folders ORDER BY name COLLATE NOCASE")
      .all()
      .filter((x) => serviceAllowed(req, x.service))
      .map((x) => ({ ...x, canEdit: manager(req), canDelete: manager(req) }));
  const documentFor = (req, row) => {
    if (!row) throw new HttpError(404, "Document niet gevonden.");
    getFolder(req, row.folder_id);
    const { storage_name, fields, ...safe } = row;
    return {
      ...safe,
      fields: safeJson(fields),
      canEdit: manager(req) || row.created_by === req.auth.user.id,
      canDelete: manager(req) || row.created_by === req.auth.user.id,
    };
  };
  const getDocument = (req) => {
    const row = db
      .prepare("SELECT * FROM workspace_documents WHERE id=?")
      .get(req.params.id);
    documentFor(req, row);
    return row;
  };
  const documentsFor = (req) => {
    const folders = new Set(foldersFor(req).map((x) => x.id));
    return db
      .prepare("SELECT * FROM workspace_documents ORDER BY updated_at DESC")
      .all()
      .filter((x) => folders.has(x.folder_id))
      .map((x) => documentFor(req, x));
  };
  const coursesFor = (req) =>
    db
      .prepare("SELECT * FROM training_courses ORDER BY name COLLATE NOCASE")
      .all()
      .filter((x) => serviceAllowed(req, x.service));
  const getCourse = (req, courseId) => {
    const row = db
      .prepare("SELECT * FROM training_courses WHERE id=?")
      .get(courseId);
    requireValue(row, 404, "Opleiding niet gevonden.");
    assertService(req, row.service);
    return row;
  };
  const peopleFor = (req) => {
    const result = req.auth.grants.policeRead
      ? listPersonnel(db).map((x) => ({
          id: x.id,
          name: x.discord_name,
          discord_id: x.discord_id,
          service: "police",
          user_id: null,
          rank: x.rank,
          callsign: x.callsign,
        }))
      : [];
    const accounts = db
      .prepare(
        "SELECT id,username,discord_id FROM users WHERE enabled=1 ORDER BY username",
      )
      .all();
    for (const account of accounts) {
      const personnel = result.find((x) => x.discord_id === account.discord_id);
      if (personnel) {
        personnel.user_id = account.id;
        continue;
      }
      if (
        req.auth.grants.owner ||
        req.auth.grants.admin ||
        account.id === req.auth.user.id
      )
        result.push({
          id: account.id,
          user_id: account.id,
          name: account.username,
          discord_id: account.discord_id,
          service:
            account.id === req.auth.user.id && req.auth.grants.ambulance
              ? "ambulance"
              : "shared",
          rank: "",
          callsign: "",
        });
    }
    return result;
  };
  const completionsFor = (req) => {
    const courses = new Set(coursesFor(req).map((x) => x.id));
    const people = peopleFor(req),
      personIds = new Set(people.map((x) => x.id));
    return db
      .prepare(
        `SELECT c.*,t.name course_name,t.qualification,COALESCE(p.discord_name,u.username,'Onbekend') person_name
      FROM training_completions c JOIN training_courses t ON t.id=c.course_id
      LEFT JOIN personnel p ON p.id=c.personnel_id LEFT JOIN users u ON u.id=c.user_id ORDER BY c.completed_on DESC`,
      )
      .all()
      .filter(
        (x) =>
          courses.has(x.course_id) &&
          (manager(req) ||
            x.user_id === req.auth.user.id ||
            personIds.has(x.personnel_id)),
      );
  };
  const requestsFor = (req) =>
    db
      .prepare(
        `SELECT r.*,u.username FROM employee_requests r JOIN users u ON u.id=r.user_id ORDER BY r.created_at DESC`,
      )
      .all()
      .filter(
        (x) =>
          x.user_id === req.auth.user.id ||
          (manager(req) && serviceAllowed(req, x.service)),
      );
  const changed = (req, action, target, before, after) =>
    audit(db, req.auth.user, action, target, before, after);

  app.get("/api/workspace/bootstrap", ...secure, (req, res) =>
    res.json({
      folders: foldersFor(req),
      documents: documentsFor(req),
      templates: documentTemplates,
      courses: coursesFor(req),
      completions: completionsFor(req),
      requests: requestsFor(req),
      people: peopleFor(req),
      permissions: { manage: manager(req), services: allowedServices(req) },
    }),
  );
  app.get("/api/workspace/templates", ...secure, (req, res) =>
    res.json({ templates: documentTemplates }),
  );
  app.post("/api/workspace/folders", ...write, (req, res) => {
    assertManager(req);
    const parent = req.body.parent_id
      ? getFolder(req, req.body.parent_id)
      : null;
    const service = parent?.service || req.body.service || "shared";
    requireValue(services.includes(service), 400, "Kies een geldige afdeling.");
    assertService(req, service);
    requireValue(
      !parent || !req.body.service || parent.service === req.body.service,
      400,
      "Een submap hoort bij dezelfde afdeling als de bovenliggende map.",
    );
    const row = {
      id: id(),
      name: text(req.body.name, "Mapnaam", 100),
      parent_id: parent?.id || null,
      service,
      created_by: req.auth.user.id,
      created_at: timestamp(),
      updated_at: timestamp(),
    };
    transaction(db, () => {
      db.prepare("INSERT INTO workspace_folders VALUES(?,?,?,?,?,?,?)").run(
        ...Object.values(row),
      );
      changed(req, "verkenner.map_aangemaakt", row.id, null, row);
    });
    res.status(201).json({ ...row, canEdit: true, canDelete: true });
  });
  app.put("/api/workspace/folders/:id", ...write, (req, res) => {
    assertManager(req);
    const before = getFolder(req, req.params.id);
    const parentId =
      req.body.parent_id === undefined
        ? before.parent_id
        : req.body.parent_id || null;
    const parent = parentId ? getFolder(req, parentId) : null;
    requireValue(
      !parent || parent.service === before.service,
      400,
      "Verplaatsen naar een andere afdeling is niet toegestaan.",
    );
    requireValue(
      !req.body.service || req.body.service === before.service,
      400,
      "De afdeling van een bestaande map kan niet wijzigen.",
    );
    let cursor = parent;
    const visited = new Set([before.id]);
    while (cursor) {
      requireValue(
        !visited.has(cursor.id),
        400,
        "Een map kan niet in zichzelf worden geplaatst.",
      );
      visited.add(cursor.id);
      cursor = cursor.parent_id ? getFolder(req, cursor.parent_id) : null;
    }
    const name = text(req.body.name ?? before.name, "Mapnaam", 100),
      now = timestamp();
    transaction(db, () => {
      db.prepare(
        "UPDATE workspace_folders SET name=?,parent_id=?,updated_at=? WHERE id=?",
      ).run(name, parentId, now, before.id);
      changed(req, "verkenner.map_gewijzigd", before.id, before, {
        name,
        parent_id: parentId,
      });
    });
    res.json({
      ...before,
      name,
      parent_id: parentId,
      updated_at: now,
      canEdit: true,
      canDelete: true,
    });
  });
  app.delete("/api/workspace/folders/:id", ...write, (req, res) => {
    assertManager(req);
    const row = getFolder(req, req.params.id);
    requireValue(
      !db
        .prepare("SELECT id FROM workspace_folders WHERE parent_id=? LIMIT 1")
        .get(row.id) &&
        !db
          .prepare(
            "SELECT id FROM workspace_documents WHERE folder_id=? LIMIT 1",
          )
          .get(row.id),
      409,
      "Verplaats of verwijder eerst de inhoud van deze map.",
    );
    transaction(db, () => {
      db.prepare("DELETE FROM workspace_folders WHERE id=?").run(row.id);
      changed(req, "verkenner.map_verwijderd", row.id, row, null);
    });
    res.json({ ok: true });
  });
  app.get("/api/workspace/documents/:id", ...secure, (req, res) =>
    res.json(documentFor(req, getDocument(req))),
  );
  app.post("/api/workspace/documents", ...write, upload, async (req, res) => {
    const folder = getFolder(req, req.body.folder_id);
    const template = req.body.template_key
      ? documentTemplates.find((x) => x.key === req.body.template_key)
      : null;
    requireValue(
      !req.body.template_key || template,
      400,
      "Sjabloon niet gevonden.",
    );
    const fields = cleanFields(
      typeof req.body.fields === "string"
        ? safeJson(req.body.fields, null)
        : req.body.fields || {},
      template,
    );
    const row = {
      id: id(),
      folder_id: folder.id,
      title: text(req.body.title, "Titel", 180),
      kind: req.file ? "file" : "document",
      filename: null,
      mime: null,
      size: 0,
      storage_name: null,
      template_key: template?.key || null,
      content: optional(req.body.content, "Documenttekst", 60000),
      fields: JSON.stringify(fields),
      created_by: req.auth.user.id,
      created_at: timestamp(),
      updated_at: timestamp(),
    };
    requireValue(
      req.file || row.content || Object.keys(fields).length,
      400,
      "Kies een bestand of schrijf een document.",
    );
    try {
      if (req.file) {
        row.filename = text(
          path.basename(req.file.originalname.replaceAll("\\", "/")),
          "Bestandsnaam",
          180,
        );
        const detected = detectWorkspaceFile(req.file.buffer, row.filename);
        row.mime = detected.mime;
        row.size = req.file.size;
        row.storage_name = id() + detected.ext;
        await archiveFiles.put(row.storage_name, req.file.buffer);
      }
      transaction(db, () => {
        db.prepare(
          "INSERT INTO workspace_documents VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ).run(...Object.values(row));
        changed(req, "verkenner.document_toegevoegd", row.id, null, {
          title: row.title,
          folder_id: row.folder_id,
          kind: row.kind,
          filename: row.filename,
        });
      });
    } catch (error) {
      if (row.storage_name)
        await archiveFiles.delete(row.storage_name).catch(() => {});
      throw error;
    }
    res.status(201).json(documentFor(req, row));
  });
  app.put("/api/workspace/documents/:id", ...write, (req, res) => {
    const before = getDocument(req);
    requireValue(
      manager(req) || before.created_by === req.auth.user.id,
      403,
      "Je kunt alleen je eigen documenten aanpassen.",
    );
    const folder = getFolder(req, req.body.folder_id || before.folder_id);
    const previousFolder = getFolder(req, before.folder_id);
    requireValue(
      previousFolder.service === folder.service,
      400,
      "Documenten verplaatsen tussen afdelingen is niet toegestaan.",
    );
    const template = before.template_key
      ? documentTemplates.find((x) => x.key === before.template_key)
      : null;
    const row = {
      ...before,
      folder_id: folder.id,
      title: text(req.body.title ?? before.title, "Titel", 180),
      content: optional(
        req.body.content ?? before.content,
        "Documenttekst",
        60000,
      ),
      fields: JSON.stringify(
        req.body.fields === undefined
          ? safeJson(before.fields)
          : cleanFields(req.body.fields, template),
      ),
      updated_at: timestamp(),
    };
    transaction(db, () => {
      db.prepare(
        "UPDATE workspace_documents SET folder_id=?,title=?,content=?,fields=?,updated_at=? WHERE id=?",
      ).run(
        row.folder_id,
        row.title,
        row.content,
        row.fields,
        row.updated_at,
        row.id,
      );
      changed(
        req,
        "verkenner.document_gewijzigd",
        row.id,
        { title: before.title, folder_id: before.folder_id },
        { title: row.title, folder_id: row.folder_id },
      );
    });
    res.json(documentFor(req, row));
  });
  app.get("/api/workspace/documents/:id/file", ...secure, async (req, res) => {
    const row = getDocument(req);
    requireValue(
      row.storage_name,
      404,
      "Dit document heeft geen geüpload bestand.",
    );
    const buffer = await archiveFiles.get(row.storage_name);
    requireValue(buffer, 404, "Bestand niet gevonden.");
    res.set(
      "Content-Security-Policy",
      "default-src 'none'; frame-ancestors 'self'; sandbox",
    );
    res.set("X-Content-Type-Options", "nosniff");
    res.type(row.mime);
    if (
      (req.query.inline === "1" || req.query.preview === "1") &&
      (/^image\//.test(row.mime) ||
        row.mime === "application/pdf" ||
        row.mime.startsWith("text/plain"))
    )
      res.set("Content-Disposition", "inline");
    else res.attachment(row.filename);
    res.send(buffer);
  });
  app.delete("/api/workspace/documents/:id", ...write, async (req, res) => {
    const row = getDocument(req);
    requireValue(
      manager(req) || row.created_by === req.auth.user.id,
      403,
      "Je kunt alleen je eigen documenten verwijderen.",
    );
    transaction(db, () => {
      db.prepare("DELETE FROM workspace_documents WHERE id=?").run(row.id);
      changed(
        req,
        "verkenner.document_verwijderd",
        row.id,
        { title: row.title, folder_id: row.folder_id },
        null,
      );
    });
    if (row.storage_name)
      await archiveFiles.delete(row.storage_name).catch(() => {});
    res.json({ ok: true });
  });

  const courseInput = (req, before = {}) => {
    const service = req.body.service ?? before.service ?? "shared";
    requireValue(services.includes(service), 400, "Kies een geldige afdeling.");
    assertService(req, service);
    return {
      name: text(req.body.name ?? before.name, "Opleidingsnaam", 140),
      description: optional(
        req.body.description ?? before.description,
        "Beschrijving",
        3000,
      ),
      qualification: optional(
        req.body.qualification ?? before.qualification,
        "Bevoegdheid",
        160,
      ),
      valid_months: positive(
        req.body.valid_months ?? before.valid_months ?? 0,
        "Geldigheid",
        120,
      ),
      service,
      active:
        req.body.active === undefined
          ? (before.active ?? 1)
          : req.body.active
            ? 1
            : 0,
    };
  };
  app.post("/api/workspace/courses", ...write, (req, res) => {
    assertManager(req);
    const row = {
      id: id(),
      ...courseInput(req),
      created_by: req.auth.user.id,
      created_at: timestamp(),
      updated_at: timestamp(),
    };
    transaction(db, () => {
      db.prepare(
        "INSERT INTO training_courses VALUES(?,?,?,?,?,?,?,?,?,?)",
      ).run(...Object.values(row));
      changed(req, "opleiding.aangemaakt", row.id, null, row);
    });
    res.status(201).json(row);
  });
  app.put("/api/workspace/courses/:id", ...write, (req, res) => {
    assertManager(req);
    const before = getCourse(req, req.params.id),
      next = courseInput(req, before);
    requireValue(
      next.service === before.service,
      400,
      "De afdeling van een opleiding kan niet wijzigen.",
    );
    transaction(db, () => {
      db.prepare(
        "UPDATE training_courses SET name=?,description=?,qualification=?,valid_months=?,service=?,active=?,updated_at=? WHERE id=?",
      ).run(...Object.values(next), timestamp(), before.id);
      changed(req, "opleiding.gewijzigd", before.id, before, next);
    });
    res.json({ ...before, ...next });
  });
  app.delete("/api/workspace/courses/:id", ...write, (req, res) => {
    assertManager(req);
    const before = getCourse(req, req.params.id);
    requireValue(
      !db
        .prepare(
          "SELECT id FROM training_completions WHERE course_id=? LIMIT 1",
        )
        .get(before.id) &&
        !db
          .prepare("SELECT id FROM employee_requests WHERE course_id=? LIMIT 1")
          .get(before.id),
      409,
      "Deze opleiding is in gebruik. Zet de opleiding op inactief om de historie te bewaren.",
    );
    transaction(db, () => {
      db.prepare("DELETE FROM training_courses WHERE id=?").run(before.id);
      changed(req, "opleiding.verwijderd", before.id, before, null);
    });
    res.json({ ok: true });
  });
  const completionInput = (req, before = {}) => {
    const course = getCourse(req, req.body.course_id ?? before.course_id),
      people = peopleFor(req);
    const selected = people.find(
      (x) =>
        x.id ===
        (req.body.personnel_id ||
          req.body.user_id ||
          before.personnel_id ||
          before.user_id),
    );
    requireValue(
      selected,
      400,
      "Kies een medewerker uit de toegankelijke afdeling.",
    );
    requireValue(
      course.service === "shared" ||
        selected.service === course.service ||
        selected.service === "shared",
      400,
      "Deze opleiding hoort bij een andere afdeling.",
    );
    const completed_on = date(
      req.body.completed_on ?? before.completed_on,
      "Afrondingsdatum",
      true,
    );
    let expiry = req.body.expires_on;
    if (expiry === undefined && before.id) expiry = before.expires_on;
    if (expiry === undefined && course.valid_months) {
      const d = new Date(completed_on + "T00:00:00Z");
      d.setUTCMonth(d.getUTCMonth() + course.valid_months);
      expiry = d.toISOString().slice(0, 10);
    }
    const expires_on = date(expiry, "Vervaldatum");
    requireValue(
      !expires_on || expires_on >= completed_on,
      400,
      "De vervaldatum ligt voor de afronding.",
    );
    return {
      course_id: course.id,
      personnel_id: selected.id !== selected.user_id ? selected.id : null,
      user_id: selected.user_id || null,
      completed_on,
      expires_on,
      note: optional(req.body.note ?? before.note, "Notitie", 2000),
    };
  };
  app.post("/api/workspace/completions", ...write, (req, res) => {
    assertManager(req);
    const row = {
      id: id(),
      ...completionInput(req),
      created_by: req.auth.user.id,
      created_at: timestamp(),
      updated_at: timestamp(),
    };
    transaction(db, () => {
      db.prepare(
        "INSERT INTO training_completions VALUES(?,?,?,?,?,?,?,?,?,?)",
      ).run(...Object.values(row));
      changed(req, "opleiding.afronding_toegevoegd", row.id, null, row);
    });
    res.status(201).json(row);
  });
  app.put("/api/workspace/completions/:id", ...write, (req, res) => {
    assertManager(req);
    const before = db
      .prepare("SELECT * FROM training_completions WHERE id=?")
      .get(req.params.id);
    requireValue(before, 404, "Afronding niet gevonden.");
    getCourse(req, before.course_id);
    const next = completionInput(req, before);
    transaction(db, () => {
      db.prepare(
        "UPDATE training_completions SET course_id=?,personnel_id=?,user_id=?,completed_on=?,expires_on=?,note=?,updated_at=? WHERE id=?",
      ).run(...Object.values(next), timestamp(), before.id);
      changed(req, "opleiding.afronding_gewijzigd", before.id, before, next);
    });
    res.json({ ...before, ...next });
  });
  app.delete("/api/workspace/completions/:id", ...write, (req, res) => {
    assertManager(req);
    const row = db
      .prepare("SELECT * FROM training_completions WHERE id=?")
      .get(req.params.id);
    requireValue(row, 404, "Afronding niet gevonden.");
    getCourse(req, row.course_id);
    transaction(db, () => {
      db.prepare("DELETE FROM training_completions WHERE id=?").run(row.id);
      changed(req, "opleiding.afronding_verwijderd", row.id, row, null);
    });
    res.json({ ok: true });
  });

  app.post("/api/workspace/requests", ...write, (req, res) => {
    const body = req.body;
    requireValue(
      ["leave", "training", "material"].includes(body.type),
      400,
      "Kies een geldig aanvraagtype.",
    );
    const service =
      body.service ||
      (req.auth.grants.policeRead
        ? "police"
        : req.auth.grants.ambulance
          ? "ambulance"
          : "shared");
    assertService(req, service);
    const course = body.course_id ? getCourse(req, body.course_id) : null;
    requireValue(
      !course || course.active,
      400,
      "Deze opleiding is niet meer beschikbaar.",
    );
    requireValue(
      !course || course.service === "shared" || course.service === service,
      400,
      "Deze opleiding hoort bij een andere afdeling.",
    );
    const start_date = date(
        body.start_date,
        "Begindatum",
        body.type === "leave",
      ),
      end_date = date(body.end_date, "Einddatum", body.type === "leave");
    requireValue(
      !start_date || !end_date || end_date >= start_date,
      400,
      "De einddatum ligt voor de begindatum.",
    );
    const row = {
      id: id(),
      user_id: req.auth.user.id,
      service,
      type: body.type,
      title: text(body.title, "Onderwerp", 160),
      description: text(body.description, "Toelichting", 6000),
      start_date,
      end_date,
      course_id: course?.id || null,
      status: "pending",
      review_reason: "",
      reviewed_by: null,
      reviewed_at: null,
      created_at: timestamp(),
      updated_at: timestamp(),
    };
    transaction(db, () => {
      db.prepare(
        "INSERT INTO employee_requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ).run(...Object.values(row));
      changed(req, "aanvraag.ingediend", row.id, null, {
        type: row.type,
        title: row.title,
        service: row.service,
      });
    });
    res.status(201).json({ ...row, username: req.auth.user.username });
  });
  app.put("/api/workspace/requests/:id/review", ...write, (req, res) => {
    assertManager(req);
    const before = db
      .prepare("SELECT * FROM employee_requests WHERE id=?")
      .get(req.params.id);
    requireValue(before, 404, "Aanvraag niet gevonden.");
    assertService(req, before.service);
    requireValue(
      before.user_id !== req.auth.user.id,
      403,
      "Je kunt je eigen aanvraag niet beoordelen.",
    );
    requireValue(
      before.status === "pending",
      409,
      "Deze aanvraag is al beoordeeld.",
    );
    requireValue(
      ["approved", "rejected"].includes(req.body.status),
      400,
      "Kies goedkeuren of afwijzen.",
    );
    const reason = text(
        req.body.reason,
        "Toelichting bij de beoordeling",
        3000,
      ),
      now = timestamp();
    transaction(db, () => {
      db.prepare(
        "UPDATE employee_requests SET status=?,review_reason=?,reviewed_by=?,reviewed_at=?,updated_at=? WHERE id=?",
      ).run(req.body.status, reason, req.auth.user.id, now, now, before.id);
      changed(
        req,
        "aanvraag.beoordeeld",
        before.id,
        { status: before.status },
        { status: req.body.status, reason },
      );
    });
    res.json({
      ...before,
      status: req.body.status,
      review_reason: reason,
      reviewed_by: req.auth.user.id,
      reviewed_at: now,
      updated_at: now,
    });
  });

  const draftKey = (req) => {
    const key = text(req.params.key, "Conceptsleutel", 120);
    requireValue(
      /^[a-zA-Z0-9_.:-]+$/.test(key),
      400,
      "Ongeldige conceptsleutel.",
    );
    return key;
  };
  const forbiddenDraftKey =
    /(?:password|wachtwoord|secret|token|credential|authorization|csrf|cookie)/i;
  function validateDraft(value, depth = 0) {
    requireValue(depth <= 12, 400, "Het concept bevat te veel niveaus.");
    if (value && typeof value === "object")
      for (const [key, entry] of Object.entries(value)) {
        requireValue(
          !forbiddenDraftKey.test(key),
          400,
          "Geheime gegevens kunnen niet in een concept worden bewaard.",
        );
        validateDraft(entry, depth + 1);
      }
    else
      requireValue(
        value === null ||
          ["string", "number", "boolean"].includes(typeof value),
        400,
        "Ongeldig concept.",
      );
  }
  app.get("/api/drafts/:key", ...secure, (req, res) => {
    const row = db
      .prepare(
        "SELECT value,updated_at FROM form_drafts WHERE user_id=? AND key=?",
      )
      .get(req.auth.user.id, draftKey(req));
    requireValue(row, 404, "Geen concept gevonden.");
    res.json({ value: safeJson(row.value, null), updated_at: row.updated_at });
  });
  app.put("/api/drafts/:key", ...write, (req, res) => {
    const key = draftKey(req);
    validateDraft(req.body.value);
    const value = JSON.stringify(req.body.value);
    requireValue(
      value && Buffer.byteLength(value) <= 60000,
      400,
      "Het concept is te groot.",
    );
    const count = db
      .prepare("SELECT COUNT(*) count FROM form_drafts WHERE user_id=?")
      .get(req.auth.user.id).count;
    requireValue(
      count < 50 ||
        db
          .prepare("SELECT key FROM form_drafts WHERE user_id=? AND key=?")
          .get(req.auth.user.id, key),
      400,
      "Er kunnen maximaal 50 concepten worden bewaard.",
    );
    const now = timestamp();
    db.prepare(
      "INSERT INTO form_drafts VALUES(?,?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
    ).run(req.auth.user.id, key, value, now);
    res.json({ ok: true, updated_at: now });
  });
  app.delete("/api/drafts/:key", ...write, (req, res) => {
    db.prepare("DELETE FROM form_drafts WHERE user_id=? AND key=?").run(
      req.auth.user.id,
      draftKey(req),
    );
    res.json({ ok: true });
  });

  app.get("/api/search", ...secure, (req, res) => {
    const query = text(
      req.query.q ?? "",
      "Zoekopdracht",
      100,
      true,
    ).toLocaleLowerCase("nl");
    if (query.length < 2) return res.json({ results: [] });
    const matches = (...parts) =>
        parts.some((x) =>
          String(x ?? "")
            .toLocaleLowerCase("nl")
            .includes(query),
        ),
      results = [];
    if (req.auth.grants.policeRead) {
      for (const person of listPersonnel(db))
        if (
          matches(
            person.discord_name,
            person.rank,
            person.callsign,
            person.place,
          )
        )
          results.push({
            id: person.id,
            type: "personnel",
            title: person.discord_name,
            subtitle: [person.rank, person.callsign, person.place]
              .filter(Boolean)
              .join(" · "),
            action: "personnel",
          });
      for (const callsign of listCallsigns(db))
        if (matches(callsign.number, callsign.place, callsign.discord_name))
          results.push({
            id: callsign.id,
            type: "callsign",
            title: callsign.number,
            subtitle: callsign.discord_name || "Vrij roepnummer",
            action: "callsigns",
          });
    }
    if (req.auth.grants.archive)
      for (const entry of db
        .prepare(
          "SELECT id,title,description FROM archive ORDER BY updated_at DESC",
        )
        .all())
        if (matches(entry.title, entry.description))
          results.push({
            id: entry.id,
            type: "archive",
            title: entry.title,
            subtitle: entry.description,
            action: "archive",
          });
    for (const doc of documentsFor(req))
      if (
        matches(
          doc.title,
          doc.filename,
          doc.content,
          ...Object.values(doc.fields),
        )
      )
        results.push({
          id: doc.id,
          type: "document",
          title: doc.title,
          subtitle:
            doc.filename ||
            documentTemplates.find((x) => x.key === doc.template_key)?.name ||
            "Document",
          action: "files",
          folder_id: doc.folder_id,
        });
    for (const course of coursesFor(req))
      if (matches(course.name, course.qualification))
        results.push({
          id: course.id,
          type: "course",
          title: course.name,
          subtitle: course.qualification,
          action: "training",
        });
    res.json({ results: results.slice(0, 60) });
  });
}
