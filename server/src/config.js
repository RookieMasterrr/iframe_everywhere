import "dotenv/config";

const num = (v, d) => (v === undefined ? d : Number(v));

export const config = {
  port: num(process.env.PORT, 8787),
  // Origin allowed to call the API and open a stream.
  publicOrigin: process.env.PUBLIC_ORIGIN || "http://localhost:5173",

  sessionIdleMs: num(process.env.SESSION_IDLE_MS, 180_000),
  maxSessions: num(process.env.MAX_SESSIONS, 4),

  // Reserved IP ranges to re-permit, comma-separated CIDRs. Empty by default.
  // Every entry is real SSRF surface — see lib/ssrf.js before adding any.
  ssrfAllowCidrs: (process.env.SSRF_ALLOW_CIDRS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
};
