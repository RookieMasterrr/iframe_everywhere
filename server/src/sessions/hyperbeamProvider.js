import { config } from "../config.js";

/**
 * Hosted remote browser (Hyperbeam). Real WebRTC video, so the stream is far
 * more efficient and much lower latency than the local JPEG provider, and none
 * of the scaling is your problem.
 *
 * The client just drops `embedUrl` into an iframe — Hyperbeam serves its own
 * page with permissive frame-ancestors, so framing it works directly.
 */
export class HyperbeamSession {
  constructor(id, startUrl, { width = 1280, height = 720 } = {}) {
    this.id = id;
    this.startUrl = startUrl;
    this.width = width;
    this.height = height;
    this.lastActivity = Date.now();
    this.closed = false;
    this.remote = null;
    this.clients = new Set(); // unused; kept so the manager can treat both alike
  }

  async start() {
    if (!config.hyperbeamKey) {
      throw Object.assign(new Error("HYPERBEAM_API_KEY is not set"), { status: 500 });
    }

    const res = await fetch("https://engine.hyperbeam.com/v0/vm", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.hyperbeamKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        start_url: this.startUrl,
        width: this.width,
        height: this.height,
        kiosk: true,
        // Belt and braces: we reap idle sessions ourselves, but if this process
        // dies the VM should still not bill forever.
        offline_timeout: Math.ceil(config.sessionIdleMs / 1000),
      }),
      signal: AbortSignal.timeout(20_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw Object.assign(new Error(`Hyperbeam ${res.status}: ${body.slice(0, 200)}`), {
        status: 502,
      });
    }

    this.remote = await res.json();
    return this;
  }

  touch() {
    this.lastActivity = Date.now();
  }

  get idleMs() {
    return Date.now() - this.lastActivity;
  }

  attach() {}
  detach() {}
  async handleInput() {}

  async close() {
    if (this.closed) return;
    this.closed = true;
    const sessionId = this.remote?.session_id;
    if (!sessionId) return;
    await fetch(`https://engine.hyperbeam.com/v0/vm/${sessionId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${config.hyperbeamKey}` },
    }).catch(() => {});
  }

  toJSON() {
    return {
      id: this.id,
      provider: "hyperbeam",
      startUrl: this.startUrl,
      width: this.width,
      height: this.height,
      idleMs: this.idleMs,
      embedUrl: this.remote?.embed_url,
      idleTimeoutMs: config.sessionIdleMs,
    };
  }
}
