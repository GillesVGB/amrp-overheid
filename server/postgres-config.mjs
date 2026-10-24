export function postgresConfig(env = process.env) {
  const supabase = String(env.SUPABASE_DATABASE_URL || "").trim();
  const connectionString =
    supabase || String(env.POSTGRES_URL || env.DATABASE_URL || "").trim();
  if (!connectionString)
    throw new Error(
      "Koppel eerst een PostgreSQL-database aan dit Vercel-project.",
    );
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error("De PostgreSQL-verbindingsinstelling is ongeldig.");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.hostname ||
    !url.username ||
    url.pathname.length < 2
  )
    throw new Error(
      "Gebruik een PostgreSQL-verbindingsadres voor de database.",
    );
  const protectPublicTables =
    Boolean(supabase) ||
    /(?:\.supabase\.co|\.pooler\.supabase\.com)$/.test(url.hostname);
  if (protectPublicTables && url.searchParams.get("sslmode") !== "verify-full")
    throw new Error(
      "Gebruik sslmode=verify-full voor de Supabase-databaseverbinding.",
    );
  if (protectPublicTables) {
    // pg's URL sslmode would replace the explicit CA settings. Validate it
    // above, then pass verified TLS configuration directly to the driver.
    url.searchParams.delete("sslmode");
    for (const key of ["sslcert", "sslkey", "sslrootcert", "uselibpqcompat"])
      url.searchParams.delete(key);
    return {
      connectionString: url.href,
      protectPublicTables,
      ssl: {
        ca: fs.readFileSync(
          new URL("./certs/supabase-prod-ca-2021.crt", import.meta.url),
          "utf8",
        ),
        rejectUnauthorized: true,
      },
    };
  }
  return { connectionString, protectPublicTables };
}
import fs from "node:fs";
