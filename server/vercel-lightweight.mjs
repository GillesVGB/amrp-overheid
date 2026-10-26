import { tmpdir } from "node:os";
import { createCreatorProfile } from "./creator-profile.mjs";
import { readPublicMaintenance } from "./public-maintenance.mjs";
import { vercelDatabasePool } from "./vercel-database.mjs";
import {
  toVercelWebRequest,
  sendVercelResponse,
} from "./vercel-function-adapter.mjs";

const profile = createCreatorProfile();
let config;
async function runtimeConfig() {
  const { configFromEnv } = await import("./config.mjs");
  return (config ??= configFromEnv({
    ...process.env,
    NODE_ENV: "production",
    DATA_DIR: tmpdir(),
  }));
}

export function createLightweightResponse({
  getPool = vercelDatabasePool,
  getConfig = runtimeConfig,
  creator = profile,
  maintenance = readPublicMaintenance,
  revision = async (...args) =>
    (await import("./revision-state.mjs")).readAuthenticatedRevision(...args),
} = {}) {
  return async (request) => {
    if (!["GET", "HEAD"].includes(request.method)) return null;
    const pathname = new URL(request.url).pathname;
    if (pathname === "/api/creator")
      return Response.json(await creator(), {
        headers: {
          "Cache-Control": "public, max-age=60",
          "Vercel-CDN-Cache-Control":
            "public, s-maxage=60, stale-while-revalidate=60",
          "X-Content-Type-Options": "nosniff",
        },
      });
    if (pathname === "/api/site-status") {
      const state = await maintenance(await getPool(), async () => null);
      if (state === null) return null; // Legacy databases keep the migration path.
      return Response.json(state, {
        headers: {
          "Cache-Control": "public, max-age=15",
          "Vercel-CDN-Cache-Control": "public, s-maxage=15",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    if (pathname === "/api/changes" || pathname === "/api/me")
      return revision(await getPool(), await getConfig(), request);
    return null;
  };
}

const lightweightResponse = createLightweightResponse();
export async function handleLightweightVercelRequest(req, res) {
  if (!["GET", "HEAD"].includes(req.method || "GET")) return false;
  const request = toVercelWebRequest(
    req,
    process.env.APP_ORIGIN || "https://overheid.amsterdamrp.nl",
  );
  const response = await lightweightResponse(request);
  if (!response) return false;
  await sendVercelResponse(req, res, response);
  return true;
}
