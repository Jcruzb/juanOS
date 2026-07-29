let csrfToken = "";
const unauthorizedListeners = new Set();

export function setCsrfToken(value) {
  csrfToken = value || "";
}

export function onUnauthorized(listener) {
  unauthorizedListeners.add(listener);
  return () => {
    unauthorizedListeners.delete(listener);
  };
}

function notifyUnauthorized() {
  setCsrfToken("");
  for (const listener of unauthorizedListeners) listener();
}

export async function api(path, options = {}) {
  const method = options.method || "GET";
  const response = await fetch(`/api${path}`, {
    ...options,
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      ...(method !== "GET" && method !== "HEAD" && csrfToken ? { "x-csrf-token": csrfToken } : {}),
      ...options.headers
    }
  });
  if (response.status === 204) return null;
  const payload = await response.json();
  if (response.status === 401 && payload.error?.code !== "INVALID_CREDENTIALS") {
    notifyUnauthorized();
  }
  if (!response.ok) {
    throw Object.assign(new Error(payload.error?.message || "No se pudo completar la operación"), {
      code: payload.error?.code
    });
  }
  return payload;
}
