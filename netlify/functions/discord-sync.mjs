import {
  config as portalConfig,
  roster,
  withPortalState,
} from "../../server/netlify-runtime.mjs";

export const config = { schedule: "*/5 * * * *" };

export const handler = () =>
  withPortalState(async () => {
    if (!portalConfig.botToken)
      return { ok: false, reason: "Discord-bot niet ingesteld." };
    return roster.run();
  });
