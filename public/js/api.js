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
    const data = await response.json();
    if (!response.ok) {
      if (data.code === 'SITE_MAINTENANCE' && typeof window !== 'undefined' &&
          !(location.pathname === '/login.html' && new URLSearchParams(location.search).get('beheer') === '1')) {
        try {window.top.location.replace('/onderhoud.html');} catch {location.replace('/onderhoud.html');}
      }
      if (response.status === 401 && session) onUnauthorized(data.error);
      const error = Error(data.error || "Het verzoek is mislukt.");
      error.status = response.status;
      error.code = data.code;
      throw error;
    }
    return data;
  };
}
