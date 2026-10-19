import { randomUUID } from "node:crypto";

function expressPath(pathname) {
  const prefix = "/.netlify/functions/portal";
  if (pathname !== prefix && !pathname.startsWith(prefix + "/"))
    return pathname;

  const suffix = pathname.slice(prefix.length).replace(/^\/+/, "");
  if (!suffix) return "/";
  if (suffix === "api" || suffix.startsWith("api/")) return "/" + suffix;
  if (suffix === "auth" || suffix.startsWith("auth/")) return "/" + suffix;
  if (suffix === "discord" || suffix.startsWith("discord/"))
    return "/auth/" + suffix;
  return "/api/" + suffix;
}

export async function toLambdaEvent(request, context = {}) {
  const url = new URL(request.url);
  const pathname = expressPath(url.pathname);
  const bytes = Buffer.from(await request.arrayBuffer());
  const headers = Object.fromEntries(request.headers.entries());
  const forwardedIp =
    context.ip ||
    headers["x-nf-client-connection-ip"] ||
    headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    "";

  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: pathname,
    rawQueryString: url.search.slice(1),
    headers,
    requestContext: {
      requestId: context.requestId || randomUUID(),
      routeKey: "$default",
      stage: "$default",
      time: new Date().toISOString(),
      timeEpoch: Date.now(),
      http: {
        method: request.method,
        path: pathname,
        protocol: "HTTP/1.1",
        sourceIp: forwardedIp,
        userAgent: headers["user-agent"] || "",
      },
    },
    body: bytes.toString("base64"),
    isBase64Encoded: true,
  };
}

export function toWebResponse(result, requestMethod = "GET") {
  const status = Number(result?.statusCode) || 200;
  const headers = new Headers(result?.headers || {});
  for (const cookie of result?.cookies || [])
    headers.append("set-cookie", cookie);
  for (const [name, values] of Object.entries(result?.multiValueHeaders || {}))
    for (const value of values || []) headers.append(name, value);

  let body = result?.body ?? "";
  if (result?.isBase64Encoded) body = Buffer.from(body, "base64");
  if (requestMethod === "HEAD" || status === 204 || status === 304) body = null;

  return new Response(body, { status, headers });
}

export async function bridgeRequest(request, context, proxy) {
  const event = await toLambdaEvent(request, context);
  const result = await proxy(event, context);
  return toWebResponse(result, request.method);
}
