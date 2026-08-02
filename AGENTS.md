# AGENTS.md

Working notes for coding agents. `README.md` explains what the project is and
how to run it — read it first, then this for the parts that are easy to get
wrong.

## What this is

One thing only: open a URL in a server-side Chromium and stream it to a browser
client. It used to have two cheaper fallback tiers (direct iframe after a
`X-Frame-Options`/CSP check, then an Open Graph card + Playwright screenshot),
and a second pluggable provider backed by a hosted WebRTC VM. All of it was
deliberately removed. If you find a reference to `detect`, `preview`,
`screenshot`, `framePolicy`, `TtlCache`, "tier N", `hyperbeam`, `embedUrl`, or
`REMOTE_PROVIDER` anywhere, it is a leftover — delete it, don't rebuild it.

There is exactly one session class (`LocalSession`) and one transport
(JPEG-over-WebSocket). Don't reintroduce a provider abstraction for a second
implementation that doesn't exist yet.

## Commands

```bash
npm run setup                  # deps + playwright install chromium
npm run dev                    # server :8787 + web :5173
npm test --workspace server    # SSRF suite (node:test, no network needed)
npm run build                  # frontend to web/dist/
```

Node 20+. Server is plain ESM with no build step. Nothing is transpiled; there
is no linter or formatter configured, so match surrounding style by hand.

**This is not a git repository yet.** `git init` before doing anything you might
want to undo.

## Verifying a change

Unit tests only cover `lib/ssrf.js`. Everything else needs the real thing —
launching a browser and streaming frames is most of the behaviour, and nothing
mocks it. Run the server **with cwd set to `server/`** (see the `.env` gotcha
below) and drive it end to end:

```bash
cd server && node src/index.js &
curl -s localhost:8787/api/health
# create, stream, tear down — expect frames > 0 and a real page title in meta
```

A minimal harness: `POST /api/session`, connect a `ws` client to the returned
`streamPath`, count binary messages for ~3 s, then `DELETE` the session. Twelve
or so frames in three seconds against `https://example.com` is healthy. Always
`DELETE` — a leaked session holds a Chromium for the full idle timeout.

`GET /api/session` tells you what is currently alive if you lose track.

## Gotchas that will cost you an hour

**`server/.env` loads from the process cwd.** `dotenv/config` resolves relative
to where node was started, so `node server/src/index.js` from the repo root
silently ignores the whole file and every value falls back to its default. The
npm scripts set cwd correctly; ad-hoc commands do not. This looks exactly like
"my config change did nothing".

**`npm test` currently fails on this machine, and it is not your change.**
`server/.env` sets `SSRF_ALLOW_CIDRS=198.18.0.0/15` (the local resolver NATs
into that range) while `test/ssrf.test.js` asserts `198.18.0.1` is blocked. The
test inherits the real env through dotenv, so the two contradict each other.
`SSRF_ALLOW_CIDRS= node --test test/*.test.js` passes 9/9. Confirm this is the
only failure before assuming you broke something.

**Screencast frames must be acked.** `Page.screencastFrameAck` is sent *before*
the frame is broadcast in `localProvider.js`. Chromium emits no further frames
until the ack arrives, so reordering or dropping it freezes the stream with no
error anywhere.

**Errors are swallowed on purpose in several places.** `page.goto` on session
start, input dispatch against a navigating page, and popup handling all use
`.catch(() => {})` — these fail routinely and are not worth killing a session
over. Set `DEBUG=1` to surface input errors while debugging. Don't "fix" these
by letting them throw.

**Capacity is reserved before `start()`.** `manager.create` inserts into the map
*then* awaits the slow launch, so concurrent callers cannot both pass the cap
check. Preserve that ordering, and keep the `catch` that removes the entry when
launch fails.

**WebSocket close must not destroy the session.** A page refresh should not
throw away a browser the user is logged into; the idle reaper owns cleanup.
`ws.on("close")` only detaches the client.

## Invariants

- **Every client-supplied URL goes through `assertSafeUrl`.** Both entry points
  today are `manager.create` and the `navigate` input handler. Adding a third
  path that loads a URL without validating it is the one change that turns this
  into an SSRF proxy. The README's security section explains the model; the
  known redirect gap is documented in the `ssrf.js` header.
- **Pointer coordinates are normalised `0..1`** on the wire, clamped and scaled
  server-side. The server never learns the client's display size.
- **One browser per session, never pooled.** Real logins happen inside; cookie
  jars must not outlive or cross sessions.
- **`toJSON` is the client contract.** It carries the `streamPath` that
  `RemoteSession.vue` opens a WebSocket against. Change the shape and the
  client breaks silently.

## Where things live

| Change | File |
|---|---|
| new env var | `server/src/config.js` **and** both `.env` + `.env.example` |
| URL validation | `server/src/lib/ssrf.js` (+ a case in `test/ssrf.test.js`) |
| new input event type | `handleInput` in `localProvider.js` **and** the sender in `RemoteSession.vue` |
| session lifecycle, caps, reaping | `server/src/sessions/manager.js` |
| upgrade handling, message routing | `server/src/ws.js` |
| stream rendering, input capture | `web/src/components/RemoteSession.vue` |
| API surface | `server/src/routes/session.js` + `web/src/api.js` |

The WebSocket protocol is documented in the header comment of `ws.js` and in the
README. Update both when you change a message type — and note the comment
declares a `{"t":"error"}` frame that is never actually emitted.

## Style

Existing code explains *why*, not *what*, and the comments are load-bearing —
they record tradeoffs (JPEG vs WebRTC, `allow-same-origin` in the old iframe
sandbox, why input goes through Playwright's keyboard API rather than raw CDP)
that are not recoverable from reading the code. Match that: skip narration of
obvious mechanics, but leave a note wherever a reader would reasonably ask
"why is it done this way".

Vue: `<script setup>`, composition API, scoped styles per component. Shared CSS
custom properties live in `web/src/style.css` and are light/dark aware via
`prefers-color-scheme`. Server: ESM, named exports, `node:` prefix on builtins.
