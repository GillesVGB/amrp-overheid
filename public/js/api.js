export function createApi({
  getSession = () => null,
  onUnauthorized = () => {},
} = {}) {
  return async function api(url, { method = "GET", body } = {}) {
    const form = body instanceof FormData,
      session = getSession();
    let response;
    try {
      response = await fetch(url, {
        method,
        credentials: "same-origin",
        headers: {
          ...(body && !form ? { "Content-Type": "application/json" } : {}),
          ...(method !== "GET" && session
            ? { "X-CSRF-Token": session.csrf }
            : {}),
        },
        body: form ? body : body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      throw Error("Geen verbinding met de server. Probeer het opnieuw.");
    }
    if (response.status === 204) return null;
    let data;
    try {
      data = await response.json();
    } catch {
      const message = response.ok
        ? "De server gaf een ongeldig antwoord. Probeer het opnieuw."
        : `De server kan het verzoek nu niet verwerken (HTTP ${response.status}). Probeer het opnieuw.`;
      if (response.status === 401 && session) onUnauthorized(message);
      const error = Error(message);
      error.status = response.status;
      error.code = "INVALID_SERVER_RESPONSE";
      throw error;
    }
    if (!response.ok) {
      if (
        data?.code === "SITE_MAINTENANCE" &&
        typeof window !== "undefined" &&
        !(
          location.pathname === "/login.html" &&
          new URLSearchParams(location.search).get("beheer") === "1"
        )
      ) {
        try {
          window.top.location.replace("/onderhoud.html");
        } catch {
          location.replace("/onderhoud.html");
        }
      }
      const message =
        typeof data?.error === "string" && data.error
          ? data.error
          : "Het verzoek is mislukt.";
      if (response.status === 401 && session) onUnauthorized(message);
      const error = Error(message);
      error.status = response.status;
      error.code = data?.code;
      throw error;
    }
    return data;
  };
}
