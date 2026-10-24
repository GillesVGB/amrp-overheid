import test from "node:test";
import assert from "node:assert/strict";
import { postgresConfig } from "../server/postgres-config.mjs";

test("Supabase takes priority over both existing Neon variables", () => {
  const supabase =
    "postgresql://backend:private@aws-1-eu-west-3.pooler.supabase.com:6543/postgres?sslmode=verify-full";
  const configured = postgresConfig({
    SUPABASE_DATABASE_URL: supabase,
    POSTGRES_URL: "postgres://old:private@neon.test/old",
    DATABASE_URL: "postgres://old2:private@neon.test/old2",
  });
  const expected = new URL(supabase);
  expected.searchParams.delete("sslmode");
  assert.equal(configured.connectionString, expected.href);
  assert.equal(configured.protectPublicTables, true);
  assert.equal(configured.ssl.rejectUnauthorized, true);
  assert.match(configured.ssl.ca, /-----BEGIN CERTIFICATE-----/);
});

test("existing PostgreSQL connections remain compatible", () => {
  const value = "postgresql://backend:private@neon.test/data?sslmode=require";
  assert.deepEqual(postgresConfig({ POSTGRES_URL: value }), {
    connectionString: value,
    protectPublicTables: false,
  });
  assert.equal(postgresConfig({ DATABASE_URL: value }).connectionString, value);
});

test("Supabase rejects insecure SSL or API URLs without disclosing the secret", () => {
  for (const value of [
    "https://private.supabase.co",
    "postgresql://backend:SECRET@aws-1-eu-west-3.pooler.supabase.com:6543/postgres",
    "postgresql://backend:SECRET@aws-1-eu-west-3.pooler.supabase.com:6543/postgres?sslmode=disable",
    "not a url SECRET",
  ]) {
    assert.throws(
      () => postgresConfig({ SUPABASE_DATABASE_URL: value }),
      (error) => !error.message.includes("SECRET"),
    );
  }
});
