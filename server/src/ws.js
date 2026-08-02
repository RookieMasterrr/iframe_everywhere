import { WebSocketServer } from "ws";
import { sessionManager } from "./sessions/manager.js";

/**
 * Frame stream + input channel for a remote browser session.
 *
 * Protocol:
 *   server -> client   binary  : one JPEG frame
 *   server -> client   text    : {t:"meta"|"closed"|"error", ...}
 *   client -> server   text    : {t:"mousemove"|"mousedown"|"mouseup"|"wheel"
 *                                  |"keydown"|"keyup"|"text"|"navigate"
 *                                  |"back"|"forward"|"reload", ...}
 *
 * Pointer coordinates are normalised to 0..1 so the client can scale the
 * canvas freely without the server tracking display size.
 */
export function attachWebSocket(httpServer) {
  // noServer + manual upgrade so we can 404 unknown paths instead of
  // accepting every upgrade that reaches the process.
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url, "http://localhost");
    const match = pathname.match(/^\/ws\/session\/([\w-]+)$/);

    if (!match) {
      socket.destroy();
      return;
    }

    const session = sessionManager.get(match[1]);
    if (!session) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req, session);
    });
  });

  wss.on("connection", (ws, _req, session) => {
    session.attach(ws);

    ws.on("message", async (raw, isBinary) => {
      if (isBinary) return;
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.t === "ping") {
        session.touch();
        if (ws.readyState === 1) ws.send(JSON.stringify({ t: "pong" }));
        return;
      }

      await session.handleInput(msg);
    });

    ws.on("close", () => {
      session.detach(ws);
      // Intentionally do NOT destroy the session here — a page refresh
      // shouldn't throw away the browser. The idle reaper handles cleanup.
    });

    ws.on("error", () => session.detach(ws));
  });

  return wss;
}
