function failureDetails(error) {
  if (
    error?.code === "53000" &&
    /exceeded the quota/i.test(error.message || "")
  )
    return {
      status: 503,
      code: "DATABASE_QUOTA_EXCEEDED",
      error:
        "De database is tijdelijk niet beschikbaar doordat de gebruikslimiet is bereikt. De beheerder moet de databaselimiet bij Neon controleren.",
    };
  if (
    /^(?:08\w{3}|53\w{3}|57P0[123]|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND)$/.test(
      error?.code || "",
    ) ||
    /connection (?:terminated|timeout)|timeout exceeded when trying to connect/i.test(
      error?.message || "",
    )
  )
    return {
      status: 503,
      code: "DATABASE_UNAVAILABLE",
      error:
        "De database is tijdelijk niet bereikbaar. Probeer het later opnieuw.",
    };
  return {
    status: 500,
    code: "SERVER_ERROR",
    error:
      "De server kan het verzoek nu niet verwerken. Probeer het later opnieuw.",
  };
}

// Includes runtime initialization and the final database commit. Failed writes
// must never send the success response, session cookie or OAuth redirect first.
export async function withVercelErrorBoundary(
  req,
  res,
  operation,
  { log = console.error } = {},
) {
  try {
    return await operation();
  } catch (error) {
    const { status, code, error: message } = failureDetails(error);
    const requestId = String(req.headers?.["x-vercel-id"] || "").slice(0, 200);
    // Do not log request bodies, OAuth codes, connection strings or passwords.
    log("Portaalverzoek mislukt.", {
      code,
      causeCode: String(error?.code || "").slice(0, 40),
      requestId,
    });
    if (res.headersSent) {
      res.end();
      return;
    }
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    if (status === 503) res.setHeader("Retry-After", "60");
    res.end(
      req.method === "HEAD"
        ? null
        : JSON.stringify({
            error: message,
            code,
            ...(requestId ? { requestId } : {}),
          }),
    );
  }
}
