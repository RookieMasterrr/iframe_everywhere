const BASE = "/api";

async function json(path, options) {
  const res = await fetch(`${BASE}${path}`, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

export const api = {
  createSession: (url, size = {}) =>
    json("/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, ...size }),
    }),

  closeSession: (id) => json(`/session/${id}`, { method: "DELETE" }),

  health: () => json("/health"),
};
