# remote browser

Embed any website — including ones that refuse to be framed — by running a real
Chromium on the server and streaming it to the client.

Most sites block embedding with `X-Frame-Options: DENY` or CSP
`frame-ancestors`. The browser enforces those headers, so there is no
client-side way around them. This project sidesteps the question entirely: the
page is loaded by a browser on your machine, and the client receives video
frames plus a channel to send clicks and keystrokes back. From the site's point
of view it is being visited by an ordinary desktop Chrome, because it is.

```
 ┌─────────────────────┐                        ┌──────────────────────────────┐
 │  browser (client)   │                        │  server                      │
 │                     │  POST /api/session     │                              │
 │  App.vue            ├───────────────────────▶ │  routes/session.js           │
 │    │                │  { id, streamPath }    │    └─ sessions/manager.js    │
 │    ▼                │◀───────────────────────┤         │  cap + idle reaper │
 │  RemoteSession.vue  │                        │         ▼                    │
 │    ├─ <canvas>      │  ws /ws/session/:id    │  sessions/localProvider.js   │
 │    │   ◀── JPEG ────┼────────────────────────┤    Chromium (Playwright)     │
 │    └─ input events ─┼───────────────────────▶│    CDP Page.startScreencast  │
 │       (JSON)        │                        │                     │        │
 └─────────────────────┘                        └─────────────────────┼────────┘
                                                                      ▼
                                                              the target website
```

## Quick start

Requires Node 20 or newer.

```bash
npm run setup     # installs workspace deps + downloads Playwright's Chromium
cp server/.env.example server/.env
npm run dev       # server on :8787, web on :5173
```

Open http://localhost:5173, type a URL, click **Open session**. Cold start takes
a few seconds — a browser is being launched.

> `server/.env` is read from the **current working directory**, so it only loads
> when the server starts with its cwd set to `server/`. The npm scripts do this
> for you. Running `node server/src/index.js` from the repo root silently skips
> the file and every setting falls back to its default.

## Layout

npm workspaces, two packages, no build step on the server.

```
server/                     Express + ws API (ESM, no transpile)
  src/index.js              app wiring, CORS, error handler, graceful shutdown
  src/config.js             every env var, one object
  src/lib/ssrf.js           URL validation — the security boundary
  src/routes/session.js     create / list / destroy
  src/ws.js                 upgrade handling, frame + input plumbing
  src/sessions/manager.js   lifecycle: concurrency cap, idle reaper
  src/sessions/localProvider.js      Chromium + CDP screencast
  test/ssrf.test.js         node:test, no network or DNS needed
web/                        Vue 3 + Vite SPA
  src/App.vue               URL entry, launches a session
  src/components/RemoteSession.vue   canvas renderer + input forwarding
  src/api.js                thin fetch wrapper
```

### Scripts

| Command | What it does |
|---|---|
| `npm run setup` | `npm install` plus `playwright install chromium` |
| `npm run dev` | both processes together via concurrently |
| `npm run dev:server` | API only, with `node --watch` |
| `npm run dev:web` | Vite dev server only |
| `npm test --workspace server` | SSRF test suite |
| `npm run build` | production frontend into `web/dist/` |
| `npm start` | API in production mode |

In development Vite proxies `/api` and `/ws` to `http://localhost:8787`, so the
frontend has no API base URL to configure. Override the target with
`API_TARGET` if the server runs elsewhere.

## Configuration

All server config lives in `server/.env`; see `.env.example`.

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `8787` | HTTP + WebSocket both listen here |
| `PUBLIC_ORIGIN` | `http://localhost:5173` | the only origin allowed to call the API (CORS) |
| `SESSION_IDLE_MS` | `180000` | reap a session after this long with no input |
| `MAX_SESSIONS` | `4` | concurrent cap; over it, `POST /api/session` returns 503 |
| `SSRF_ALLOW_CIDRS` | empty | reserved ranges to re-permit — read the security section first |

## How the stream works

Playwright launches a dedicated Chromium per session. CDP's
`Page.startScreencast` emits JPEG frames (quality 70) which are pushed over a
WebSocket as binary messages; the client decodes each with `createImageBitmap`
and paints it to a `<canvas>`.

Simple, free, no external dependency. The tradeoff is bandwidth and fidelity:
JPEG-over-WebSocket costs far more than H.264 and looks soft under motion.
Fine for a handful of users on a LAN or a single box; scaling past that means
moving to a WebRTC transport, not a bigger machine.

## HTTP API

#### `GET /api/health`
```json
{ "ok": true, "publicOrigin": "http://localhost:5173", "activeSessions": 0 }
```

#### `POST /api/session`
```json
{ "url": "https://github.com", "width": 1280, "height": 720 }
```
`width` is clamped to 640–1920, `height` to 480–1080. Responds with a session
descriptor:
```json
{
  "id": "Fro32lixQK02",
  "startUrl": "https://github.com/",
  "width": 1280, "height": 720,
  "idleMs": 2402, "clients": 0,
  "streamPath": "/ws/session/Fro32lixQK02",
  "idleTimeoutMs": 180000
}
```
`400` for an unsafe or malformed URL, `503` at capacity.

#### `GET /api/session`
Lists active sessions plus `max` and `idleTimeoutMs`.

#### `DELETE /api/session/:id`
Closes the browser immediately. `200` if it existed, `404` otherwise.

## Stream protocol

Connect to `streamPath` (`/ws/session/:id`). Unknown paths are destroyed at the
upgrade; a valid path with no live session gets a `404` before the handshake
completes.

**Server → client**

| Kind | Payload |
|---|---|
| binary | one JPEG frame |
| text | `{"t":"meta","url","title","width","height","canGoBack"}` on connect and every main-frame navigation |
| text | `{"t":"closed"}` when the session is being torn down |
| text | `{"t":"pong"}` in reply to a ping |

**Client → server** (JSON text)

| `t` | Fields |
|---|---|
| `mousemove` / `mousedown` / `mouseup` | `x`, `y`, and `button` for the latter two |
| `wheel` | `x`, `y`, `dx`, `dy` |
| `keydown` / `keyup` | `key` (DOM key name) |
| `text` | `value` — inserted directly, used for paste and IME |
| `navigate` | `url` — revalidated against the SSRF guard |
| `back` / `forward` / `reload` | — |
| `ping` | keeps the idle reaper away |

Pointer coordinates are normalised to `0..1` of the stream surface, so the
client can render the canvas at any size and the server never tracks display
geometry.

Two details that matter if you touch this code. Each `Page.screencastFrame`
must be acked before Chromium emits the next one — drop the ack and the stream
silently freezes. And frames are *dropped*, not queued, for any client with
more than 2 MB buffered: for video, discarding is correct, while buffering grows
latency without bound.

## Resource management

A session is roughly one CPU core and a gigabyte of RAM, so cost control is
structural rather than an afterthought.

- **Hard cap.** `MAX_SESSIONS` concurrent, and the slot is reserved *before* the
  slow `start()` so two simultaneous callers cannot both pass the check.
- **Idle reaper.** A 15-second sweeper closes anything idle past
  `SESSION_IDLE_MS`. The common failure is someone closing the tab and leaving
  a browser running forever.
- **Heartbeat.** The client pings every 20 s, so a session being *read* rather
  than clicked is not reaped mid-article.
- **Explicit close.** The client `DELETE`s on unmount instead of waiting for the
  reaper.
- **Refresh survives.** A WebSocket close deliberately does *not* destroy the
  session — reloading the page should not throw away a browser you were logged
  into. The reaper is the safety net.
- **Clean shutdown.** SIGINT/SIGTERM close every browser before exit.

Cookie jars are never shared or pooled: people log into real accounts in these
browsers, so each session gets its own Chromium and it dies with the session.

## Security

`server/src/lib/ssrf.js` is the boundary worth understanding before deploying
anything. Session URLs come from the client and are loaded by a browser on your
machine, with the result streamed back to that same client — so without a guard,
anyone can point you at `http://169.254.169.254/` (cloud instance metadata, i.e.
credentials) or at internal services, and read the response off the video.

The guard resolves hostnames itself and checks the resulting **IP**, not the
name — `localtest.me` and countless other public names resolve to `127.0.0.1`.
On top of that it rejects non-HTTP(S) schemes, URLs with embedded credentials,
`localhost` / `.localhost` / `.local`, the full set of reserved IPv4 ranges
(loopback, RFC1918, CGNAT, link-local, multicast, broadcast), IPv6 loopback,
unique-local, link-local and multicast, and all three IPv4-in-IPv6 embeddings
(v4-mapped, v4-translated, v4-compatible) so the v4 blocklist cannot be
tunnelled through a v6 literal. Every DNS record must be safe, not just the
first — a name with one public and one private A record would otherwise be a
coin flip at connect time. In-session `navigate` messages go through the same
check.

`SSRF_ALLOW_CIDRS` re-opens specific ranges. It exists because some networks
legitimately resolve public names into reserved space — corporate proxies and
VPNs commonly NAT everything into `198.18.0.0/15` — and because embedding an
internal dashboard is a real use case. Every entry is genuine SSRF surface:
anything inside those ranges becomes reachable by anyone who can submit a URL.
Never widen it on a public deployment that accepts arbitrary URLs.

Three things to know before this faces the internet:

- **There is no authentication.** Anyone who can reach the API can spawn a
  browser, and `GET /api/session` discloses what URLs others are viewing. Put
  it behind auth.
- **Redirects are not validated.** The guard checks the URL handed to Chromium,
  but Chromium follows redirects itself, so a public URL that 302s to an
  internal address is still reachable. Closing this needs request interception
  (`page.route`) inside the session.
- **CORS does not cover WebSockets.** `PUBLIC_ORIGIN` restricts the HTTP API
  only; the upgrade handler accepts any origin. Session IDs are 72 bits of
  randomness, so they are not guessable, but add an origin check if you need a
  real boundary.

## Limitations

- Text is video-grade — readable, not crisp. Inherent to JPEG streaming;
  fixing it means a real video codec, not a quality bump.
- Modifier combinations (Cmd/Ctrl + key) are intentionally not forwarded, so
  they keep working in *your* browser. Paste is special-cased and forwarded as
  a `text` message.
- Popups and `target="_blank"` are closed and re-navigated in the main tab,
  because only that tab is being screencast.
- `canGoBack` in the `meta` message is hardcoded `true` rather than reflecting
  real history state.
- Audio is not streamed by the local provider.

## Troubleshooting

**"Target resolves to a private or reserved address" for a public site.** Your
resolver is NATing into a reserved range. Check with `dig +short example.com`;
if it lands in `198.18.0.0/15` or similar, add that CIDR to
`SSRF_ALLOW_CIDRS` — and read the security section on what you are accepting.

**Settings appear to be ignored.** The server was probably started from the
repo root instead of `server/`. See the note under Quick start.

**Session dies while reading.** Raise `SESSION_IDLE_MS`. The 20-second
heartbeat should prevent this; if it does not, check the WebSocket is actually
connected — the fps counter in the toolbar reads `0` when it is not.

**503 on every create.** `MAX_SESSIONS` is reached and sessions are idling out
their full timeout. Check `GET /api/session` and lower `SESSION_IDLE_MS`.

**Blank canvas, no frames.** Almost always the screencast ack path. Run the
server with `DEBUG=1` to surface input and CDP errors that are otherwise
swallowed.
