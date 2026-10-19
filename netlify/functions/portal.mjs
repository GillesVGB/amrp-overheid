import serverless from "serverless-http";
import { app } from "../../server/netlify-runtime.mjs";
import { withPortalState } from "../../server/netlify-runtime.mjs";

const proxy = serverless(app);

export const handler = (event, context) =>
  withPortalState(() => proxy(event, context));
