import { DatabaseSync } from "node:sqlite";
import { authentication, sessionDetails } from "./auth.mjs";
import { cookieMap, digest, HttpError } from "./security.mjs";
import { PORTAL_LOCK_ID } from "./postgres-lock.mjs";

// This is the same transaction lock used by the full compatibility adapter.
// Both paths must serialize session updates so neither can lose token rotation.
const sessionTables = ["settings", "users", "account_access", "sessions"];
const identifier = (value) => '"' + String(value).replaceAll('"', '""') + '"';
const headers = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};

function respond(body, status = 200, extraHeaders = {}) {
  return Response.json(body, {
    status,
    headers: { ...extraHeaders, ...headers },
  });
}

// Revision polling needs four small, current rows, not all personnel, documents,
// callsigns and audit records. Authentication itself remains the shared middleware.
export async function readAuthenticatedRevision(
  pool,
  config,
  request,
  options = {},
) {
  const pathname = new URL(request.url).pathname;
  if (!["/api/changes", "/api/me"].includes(pathname)) return null;
  const cookieName = config.production ? "__Host-gov-session" : "gov-session";
  const raw =
    cookieMap({ headers: { cookie: request.headers.get("cookie") || "" } })[
      cookieName
    ] || "";
  if (!raw) return respond({ error: "Meld je aan om verder te gaan." }, 401);
  const hash = digest(raw);
  const client = await pool.connect();
  let db,
    transactionOpen = false;
  try {
    await client.query("BEGIN");
    transactionOpen = true;
    await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [
      PORTAL_LOCK_ID,
    ]);
    let result;
    try {
      result = await client.query(
        `/* amrp:revision */
        SELECT m.revision,
          (SELECT jsonb_agg(entry) FROM jsonb_array_elements(m.sqlite_schema) entry
            WHERE entry->>'type'='table' AND entry->>'name' IN ('settings','users','account_access','sessions')) AS sqlite_schema,
          to_jsonb(s) AS session,to_jsonb(u) AS account,
          (SELECT to_jsonb(settings) FROM public.settings WHERE id=1) AS settings,
          to_jsonb(a) AS access
        FROM public.amrp_portal_meta m
        LEFT JOIN public.sessions s ON s.hash=$1
        LEFT JOIN public.users u ON u.id=s.user_id
        LEFT JOIN public.account_access a ON a.user_id=u.id
        WHERE m.id=1`,
        [hash],
      );
    } catch (error) {
      if (error.code !== "42P01") throw error;
      await client.query("ROLLBACK");
      transactionOpen = false;
      return null;
    }
    const row = result.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      transactionOpen = false;
      return null;
    }
    if (!row.settings || !Array.isArray(row.sqlite_schema))
      throw new Error("De opgeslagen portaalstructuur ontbreekt.");
    const schema = sessionTables.map((name) =>
      row.sqlite_schema.find(
        (entry) => entry.type === "table" && entry.name === name,
      ),
    );
    if (schema.some((entry) => !entry)) {
      await client.query("ROLLBACK");
      transactionOpen = false;
      return null;
    }
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys=ON");
    for (const entry of schema) db.exec(entry.sql);
    for (const [name, value] of [
      ["settings", row.settings],
      ["users", row.account],
      ["account_access", row.access],
      ["sessions", row.session],
    ]) {
      if (!value) continue;
      const columns = Object.keys(value);
      db.prepare(
        `INSERT INTO ${identifier(name)}(${columns.map(identifier).join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
      ).run(...Object.values(value));
    }
    const auth = authentication({ db, config, ...options });
    const req = {
      path: pathname,
      headers: { cookie: request.headers.get("cookie") || "" },
    };
    let failure, response;
    const responseHeaders = new Headers();
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      set(name, value) {
        responseHeaders.set(name, value);
        return this;
      },
      json(body) {
        response = respond(
          body,
          this.statusCode,
          Object.fromEntries(responseHeaders),
        );
        return this;
      },
    };
    await auth.auth(req, res, (error) => {
      failure = error;
    });
    if (
      pathname === "/api/changes" &&
      !failure &&
      !response &&
      req.auth?.user.must_change
    )
      failure = new HttpError(403, "Wijzig eerst je tijdelijke wachtwoord.");
    const updated = db.prepare("SELECT * FROM sessions WHERE hash=?").get(hash);
    if (row.session && !updated) {
      await client.query("DELETE FROM public.sessions WHERE hash=$1", [hash]);
    } else if (
      updated &&
      (updated.tokens !== row.session.tokens ||
        updated.last_seen !== Number(row.session.last_seen))
    ) {
      await client.query(
        "UPDATE public.sessions SET tokens=$2,last_seen=$3 WHERE hash=$1",
        [hash, updated.tokens, updated.last_seen],
      );
    }
    await client.query("COMMIT");
    transactionOpen = false;
    if (failure) {
      if (!Number.isInteger(failure.status)) throw failure;
      return respond({ error: failure.message }, failure.status);
    }
    if (response) return response;
    if (!req.auth) throw new Error("De sessiecontrole is niet afgerond.");
    if (pathname === "/api/me")
      return respond(sessionDetails(db, config, req.auth));
    return respond({ revision: String(row.revision) });
  } catch (error) {
    if (transactionOpen) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    db?.close();
    client.release();
  }
}
