let csrfToken = "";

export function setCsrfToken(value) {
  csrfToken = value || "";
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
  if (!response.ok) {
    throw Object.assign(new Error(payload.error?.message || "No se pudo completar la operación"), {
      code: payload.error?.code
    });
  }
  return payload;
}
