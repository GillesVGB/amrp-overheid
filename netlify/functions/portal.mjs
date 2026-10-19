import serverless from "serverless-http";
import { app, withPortalState } from "../../server/netlify-runtime.mjs";
import { bridgeRequest } from "../../server/netlify-function-adapter.mjs";

const proxy = serverless(app);

export default async (request, context) =>
  withPortalState(() => bridgeRequest(request, context, proxy));
