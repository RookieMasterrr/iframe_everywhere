import { chromium } from "playwright";
import { config } from "../config.js";

/**
 * Self-hosted remote browser: a real Chromium on this machine, streamed to the
 * client as JPEG frames over a WebSocket via CDP's Page.startScreencast, with
 * input events forwarded back.
 *
 * Tradeoff of JPEG-over-WebSocket versus real video: this is simple, free, and
 * has no external dependency, but it costs far more bandwidth than H.264 and
 * looks softer under motion. Fine for a few concurrent users on a LAN or a
 * single box; scaling past that needs a WebRTC transport, not a bigger box.
 *
 * Input is dispatched through Playwright's mouse/keyboard APIs rather than raw
 * CDP Input events, because Playwright already owns the messy business of
 * mapping browser key names to Windows virtual key codes.
 */
export class LocalSession {
  constructor(id, startUrl, { width = 1280, height = 720 } = {}) {
    this.id = id;
    this.startUrl = startUrl;
    this.width = width;
    this.height = height;

    this.browser = null;
    this.context = null;
    this.page = null;
    this.cdp = null;

    /** @type {Set<import("ws").WebSocket>} */
    this.clients = new Set();
    this.lastActivity = Date.now();
    this.closed = false;
  }

  async start() {
    // A dedicated browser per session, never pooled or reused: users log into
    // real accounts in here, so cookie jars must not outlive or cross sessions.
    this.browser = await chromium.launch({
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--hide-scrollbars"],
    });

    this.context = await this.browser.newContext({
      viewport: { width: this.width, height: this.height },
      // Present as an ordinary desktop Chrome. This is a genuine browser, so
      // there is no fingerprint mismatch to give the automation away.
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      locale: "en-US",
    });

    this.page = await this.context.newPage();

    // Keep everything in one tab: popups and target=_blank would otherwise
    // open pages we are not screencasting.
    this.context.on("page", async (popup) => {
      if (popup === this.page) return;
      const url = popup.url();
      await popup.close().catch(() => {});
      if (url && url !== "about:blank") {
        await this.page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
      }
    });

    this.page.on("framenavigated", (frame) => {
      if (frame === this.page.mainFrame()) this.broadcastMeta();
    });

    await this.page
      .goto(this.startUrl, { waitUntil: "domcontentloaded", timeout: 30_000 })
      .catch(() => {});

    this.cdp = await this.context.newCDPSession(this.page);

    this.cdp.on("Page.screencastFrame", async ({ data, sessionId }) => {
      // Ack first: Chromium will not emit the next frame until we do, and
      // dropping the ack silently freezes the stream.
      this.cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
      this.broadcastFrame(Buffer.from(data, "base64"));
    });

    await this.cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: 70,
      maxWidth: this.width,
      maxHeight: this.height,
      everyNthFrame: 1,
    });

    this.broadcastMeta();
    return this;
  }

  attach(ws) {
    this.clients.add(ws);
    this.touch();
    this.sendMeta(ws);
  }

  detach(ws) {
    this.clients.delete(ws);
  }

  touch() {
    this.lastActivity = Date.now();
  }

  get idleMs() {
    return Date.now() - this.lastActivity;
  }

  broadcastFrame(buffer) {
    for (const ws of this.clients) {
      // readyState 1 === OPEN. Skip clients still handshaking or closing.
      if (ws.readyState !== 1) continue;
      // Don't queue frames on a client that can't keep up — dropping is
      // correct for video, buffering just grows latency without bound.
      if (ws.bufferedAmount > 2 * 1024 * 1024) continue;
      ws.send(buffer, { binary: true });
    }
  }

  async sendMeta(ws) {
    if (ws.readyState !== 1) return;
    let url = this.startUrl;
    let title = "";
    try {
      url = this.page.url();
      title = await this.page.title();
    } catch {
      /* page may be mid-navigation */
    }
    ws.send(
      JSON.stringify({
        t: "meta",
        url,
        title,
        width: this.width,
        height: this.height,
        canGoBack: true,
      }),
    );
  }

  broadcastMeta() {
    for (const ws of this.clients) this.sendMeta(ws).catch(() => {});
  }

  /**
   * Handle one input message from a client. Coordinates arrive normalised to
   * 0..1 so the client can render the stream at any size without us caring.
   */
  async handleInput(msg) {
    if (this.closed || !this.page) return;
    this.touch();

    const px = (x) => Math.round(Math.min(Math.max(x, 0), 1) * this.width);
    const py = (y) => Math.round(Math.min(Math.max(y, 0), 1) * this.height);

    try {
      switch (msg.t) {
        case "mousemove":
          await this.page.mouse.move(px(msg.x), py(msg.y));
          break;

        case "mousedown":
          await this.page.mouse.move(px(msg.x), py(msg.y));
          await this.page.mouse.down({ button: msg.button || "left" });
          break;

        case "mouseup":
          await this.page.mouse.move(px(msg.x), py(msg.y));
          await this.page.mouse.up({ button: msg.button || "left" });
          break;

        case "wheel":
          await this.page.mouse.move(px(msg.x), py(msg.y));
          await this.page.mouse.wheel(msg.dx || 0, msg.dy || 0);
          break;

        case "keydown":
          await this.page.keyboard.down(msg.key);
          break;

        case "keyup":
          await this.page.keyboard.up(msg.key);
          break;

        case "text":
          // insertText bypasses per-key dispatch, which is what we want for
          // IME composition and pasted content.
          await this.page.keyboard.insertText(msg.value);
          break;

        case "navigate": {
          // Same SSRF rules apply here as anywhere else — this is a URL from
          // the client that our server-side browser is about to load.
          const { assertSafeUrl } = await import("../lib/ssrf.js");
          const { url } = await assertSafeUrl(msg.url);
          await this.page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 30_000 });
          break;
        }

        case "back":
          await this.page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
          break;

        case "forward":
          await this.page.goForward({ waitUntil: "domcontentloaded" }).catch(() => {});
          break;

        case "reload":
          await this.page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
          break;

        default:
          break;
      }
    } catch (err) {
      // Input against a navigating page throws routinely; not worth killing
      // the session over.
      if (process.env.DEBUG) console.warn(`[session ${this.id}] input error:`, err.message);
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;

    for (const ws of this.clients) {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ t: "closed" }));
        ws.close();
      }
    }
    this.clients.clear();

    await this.cdp?.send("Page.stopScreencast").catch(() => {});
    await this.context?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
  }

  toJSON() {
    return {
      id: this.id,
      startUrl: this.startUrl,
      width: this.width,
      height: this.height,
      idleMs: this.idleMs,
      clients: this.clients.size,
      // The client connects here for frames; the Vite dev server proxies /ws.
      streamPath: `/ws/session/${this.id}`,
      idleTimeoutMs: config.sessionIdleMs,
    };
  }
}
