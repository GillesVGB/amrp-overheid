import {
  config as portalConfig,
  roster,
  withPortalState,
} from "../../server/netlify-runtime.mjs";

export const config = { schedule: "*/5 * * * *" };

export default async () => {
  const result = await withPortalState(async () => {
    if (!portalConfig.botToken)
      return { ok: false, reason: "Discord-bot niet ingesteld." };
    return roster.run();
  });
  return Response.json(result);
};
