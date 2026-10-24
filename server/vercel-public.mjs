import { bridgeRequest } from "./netlify-function-adapter.mjs";

export function createPublicVercelResponse({ proxy, readMaintenance }) {
  return async (request, context) => {
    // Every private, auth or write route still requires the full transaction.
    if (!["GET", "HEAD"].includes(request.method)) return null;
    const pathname = new URL(request.url).pathname;
    if (pathname === "/api/creator")
      return bridgeRequest(request, context, proxy);
    if (pathname === "/api/site-status")
      return Response.json(await readMaintenance(), {
        headers: {
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    return null;
  };
}
