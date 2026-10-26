import { postgresConfig } from "./postgres-config.mjs";

let options, pool;
export function vercelDatabaseOptions() {
  return (options ??= postgresConfig());
}
export function vercelDatabasePool() {
  pool ??= import("pg")
    .then(({ Pool }) => {
      const { connectionString, ssl } = vercelDatabaseOptions();
      return new Pool({
        connectionString,
        ...(ssl ? { ssl } : {}),
        max: Number(process.env.DB_POOL_MAX || 3),
        idleTimeoutMillis: 10000,
        connectionTimeoutMillis: 10000,
      });
    })
    .catch((error) => {
      pool = undefined;
      throw error;
    });
  return pool;
}
