import { Router } from "express";
import { config } from "../config.js";
import { sessionManager } from "../sessions/manager.js";

export const sessionRouter = Router();

/** POST /api/session { url, width?, height? } -> session descriptor */
sessionRouter.post("/session", async (req, res, next) => {
  try {
    const { url, width, height } = req.body || {};
    if (!url) return res.status(400).json({ error: "Missing url" });

    const session = await sessionManager.create(url, {
      width: Math.min(Math.max(Number(width) || 1280, 640), 1920),
      height: Math.min(Math.max(Number(height) || 720, 480), 1080),
    });

    res.json(session.toJSON());
  } catch (err) {
    next(err);
  }
});

sessionRouter.get("/session", (_req, res) => {
  res.json({
    active: sessionManager.list(),
    max: config.maxSessions,
    idleTimeoutMs: config.sessionIdleMs,
  });
});

sessionRouter.delete("/session/:id", async (req, res) => {
  const existed = await sessionManager.destroy(req.params.id);
  res.status(existed ? 200 : 404).json({ closed: existed });
});
