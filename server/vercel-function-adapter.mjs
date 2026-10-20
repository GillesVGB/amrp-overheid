import { Readable } from "node:stream";
import { bridgeRequest } from "./netlify-function-adapter.mjs";

export function toVercelWebRequest(req, origin) {
  const url = new URL(req.url, origin);
  const route = url.searchParams.get("__portal_route");
  if (url.pathname === "/api/portal" && route) {
    if (!/^\/(?:api|auth)(?:\/|$)/.test(route) || /[?#\r\n]/.test(route))
      throw new Error("Ongeldige interne routering.");
    url.pathname = route;
  }
  url.searchParams.delete("__portal_route");

  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else if (value !== undefined) headers.set(name, value);
  }
  const method = req.method || "GET";
  let body;
  if (!["GET", "HEAD"].includes(method)) {
    if (req.body !== undefined && req.body !== null) {
      body = Buffer.isBuffer(req.body)
        ? req.body
        : typeof req.body === "string"
          ? req.body
          : JSON.stringify(req.body);
      headers.delete("content-length");
    } else {
      body = Readable.toWeb(req);
    }
  }
  return new Request(url, {
    method,
    headers,
    ...(body === undefined ? {} : { body, duplex: "half" }),
  });
}

export async function bridgeVercelRequest(req, res, { origin, withPortalState, proxy }) {
  const request = toVercelWebRequest(req, origin);
  const forwarded = req.headers["x-forwarded-for"];
  const context = {
    ip:
      (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim() ||
      req.socket?.remoteAddress ||
      "",
    requestId: req.headers["x-vercel-id"] || "",
  };
  // Finish the persistence transaction before sending cookies or redirects.
  const response = await withPortalState(() => bridgeRequest(request, context, proxy));
  res.statusCode = response.status;
  const cookies = response.headers.getSetCookie();
  response.headers.forEach((value, name) => {
    if (name !== "set-cookie") res.setHeader(name, value);
  });
  if (cookies.length) res.setHeader("Set-Cookie", cookies);
  const body = req.method === "HEAD" ? null : Buffer.from(await response.arrayBuffer());
  res.end(body);
}
