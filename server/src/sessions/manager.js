import crypto from "node:crypto";
import { config } from "../config.js";
import { assertSafeUrl } from "../lib/ssrf.js";
import { LocalSession } from "./localProvider.js";

/**
 * Owns the lifecycle of remote browser sessions.
 *
 * Two invariants keep this from becoming a runaway cost:
 *   - a hard cap on concurrent sessions (each is ~1 CPU core + ~1GB RAM)
 *   - an idle reaper, because the common failure is a user closing the tab
 *     and leaving a browser running forever
 */
class SessionManager {
  constructor() {
    /** @type {Map<string, LocalSession>} */
    this.sessions = new Map();
    this.sweeper = null;
  }

  startSweeper() {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => {
      for (const session of this.sessions.values()) {
        if (session.idleMs > config.sessionIdleMs) {
          console.log(`[sessions] reaping ${session.id} (idle ${Math.round(session.idleMs / 1000)}s)`);
          this.destroy(session.id);
        }
      }
    }, 15_000);
    this.sweeper.unref?.();
  }

  async create(rawUrl, { width, height } = {}) {
    if (this.sessions.size >= config.maxSessions) {
      throw Object.assign(
        new Error(`At capacity (${config.maxSessions} concurrent sessions). Try again shortly.`),
        { status: 503 },
      );
    }

    const { url } = await assertSafeUrl(rawUrl);
    const id = crypto.randomBytes(9).toString("base64url");

    const session = new LocalSession(id, url.href, { width, height });

    // Reserve the slot before the slow start() so concurrent callers can't
    // both pass the capacity check.
    this.sessions.set(id, session);
    this.startSweeper();

    try {
      await session.start();
    } catch (err) {
      this.sessions.delete(id);
      await session.close().catch(() => {});
      throw err;
    }

    console.log(`[sessions] created ${id} -> ${url.href} (${this.sessions.size}/${config.maxSessions})`);
    return session;
  }

  get(id) {
    return this.sessions.get(id);
  }

  async destroy(id) {
    const session = this.sessions.get(id);
    if (!session) return false;
    this.sessions.delete(id);
    await session.close().catch(() => {});
    return true;
  }

  async destroyAll() {
    clearInterval(this.sweeper);
    this.sweeper = null;
    await Promise.all([...this.sessions.keys()].map((id) => this.destroy(id)));
  }

  list() {
    return [...this.sessions.values()].map((s) => s.toJSON());
  }
}

export const sessionManager = new SessionManager();
