import http from "node:http";
import express from "express";
import cors from "cors";
import { config } from "./config.js";
import { sessionRouter } from "./routes/session.js";
import { attachWebSocket } from "./ws.js";
import { sessionManager } from "./sessions/manager.js";
import { UnsafeUrlError } from "./lib/ssrf.js";

const app = express();

app.use(cors({ origin: config.publicOrigin, credentials: true }));
app.use(express.json({ limit: "64kb" }));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    publicOrigin: config.publicOrigin,
    activeSessions: sessionManager.list().length,
  });
});

app.use("/api", sessionRouter);

// Central error handler. Keep internal messages out of the response body for
// unexpected failures so we don't leak detail to callers.
app.use((err, _req, res, _next) => {
  if (err instanceof UnsafeUrlError || err.status === 400) {
    return res.status(400).json({ error: err.message });
  }
  if (err.status && err.status < 500) {
    return res.status(err.status).json({ error: err.message });
  }
  console.error("[error]", err);
  res.status(500).json({ error: "Session request failed", detail: err.message });
});

const server = http.createServer(app);
attachWebSocket(server);

server.listen(config.port, () => {
  console.log(`\n  remote-browser api      http://localhost:${config.port}`);
  console.log(`  frontend origin         ${config.publicOrigin}`);
  console.log(`  session cap             ${config.maxSessions} concurrent, ${config.sessionIdleMs / 1000}s idle timeout\n`);
});

async function shutdown(signal) {
  console.log(`\n[${signal}] shutting down — closing browsers`);
  server.close();
  await sessionManager.destroyAll();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
