<script setup>
import { ref, onMounted, onBeforeUnmount, shallowRef } from "vue";
import { api } from "../api.js";

const props = defineProps({ url: { type: String, required: true } });
const emit = defineEmits(["close"]);

const status = ref("starting"); // starting | live | error | closed
const errorMessage = ref(null);
const session = shallowRef(null);
const currentUrl = ref(props.url);
const pageTitle = ref("");
const fps = ref(0);

const canvas = ref(null);
const stage = ref(null);

let ws = null;
let ctx = null;
let heartbeat = null;
let frameCount = 0;
let fpsTimer = null;
let pendingMove = null;
let moveRaf = null;

/** Pointer position normalised to 0..1 of the stream surface. */
function normalise(event) {
  const rect = canvas.value.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) / rect.width,
    y: (event.clientY - rect.top) / rect.height,
  };
}

function send(msg) {
  if (ws?.readyState === 1) ws.send(JSON.stringify(msg));
}

async function drawFrame(blob) {
  // createImageBitmap decodes off the main thread — meaningfully smoother
  // than assigning an object URL to an <img> on every frame.
  const bitmap = await createImageBitmap(blob);
  if (!ctx) return;
  if (
    canvas.value.width !== bitmap.width ||
    canvas.value.height !== bitmap.height
  ) {
    canvas.value.width = bitmap.width;
    canvas.value.height = bitmap.height;
  }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  frameCount++;
}

function connect(streamPath) {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${scheme}//${location.host}${streamPath}`);
  ws.binaryType = "blob";

  ws.onopen = () => {
    status.value = "live";
    // Keeps the server's idle reaper from killing a session the user is
    // watching but not touching (reading a long page, say).
    heartbeat = setInterval(() => send({ t: "ping" }), 20_000);
    fpsTimer = setInterval(() => {
      fps.value = frameCount;
      frameCount = 0;
    }, 1000);
  };

  ws.onmessage = (event) => {
    if (event.data instanceof Blob) {
      drawFrame(event.data);
      return;
    }
    const msg = JSON.parse(event.data);
    if (msg.t === "meta") {
      currentUrl.value = msg.url;
      pageTitle.value = msg.title;
    } else if (msg.t === "closed") {
      status.value = "closed";
    }
  };

  ws.onerror = () => {
    if (status.value !== "closed") {
      status.value = "error";
      errorMessage.value = "Lost connection to the browser stream";
    }
  };

  ws.onclose = () => {
    if (status.value === "live") status.value = "closed";
  };
}

onMounted(async () => {
  ctx = canvas.value.getContext("2d", { alpha: false });
  try {
    const created = await api.createSession(props.url, {
      width: 1280,
      height: 720,
    });
    session.value = created;

    // Hosted providers hand back an embeddable page instead of a raw stream.
    if (created.embedUrl) {
      status.value = "live";
      return;
    }

    connect(created.streamPath);
  } catch (err) {
    status.value = "error";
    errorMessage.value = err.message;
  }
});

onBeforeUnmount(() => {
  clearInterval(heartbeat);
  clearInterval(fpsTimer);
  cancelAnimationFrame(moveRaf);
  ws?.close();
  // Free the server-side browser immediately rather than waiting for the
  // idle reaper — this is the expensive resource.
  if (session.value) api.closeSession(session.value.id).catch(() => {});
});

/* ---------- input forwarding ---------- */

function onMouseMove(event) {
  // Coalesce to one move per frame; raw mousemove fires far faster than the
  // stream updates and just floods the socket.
  pendingMove = normalise(event);
  if (moveRaf) return;
  moveRaf = requestAnimationFrame(() => {
    moveRaf = null;
    if (pendingMove) send({ t: "mousemove", ...pendingMove });
  });
}

const BUTTONS = ["left", "middle", "right"];

function onMouseDown(event) {
  event.preventDefault();
  stage.value?.focus();
  send({
    t: "mousedown",
    ...normalise(event),
    button: BUTTONS[event.button] || "left",
  });
}

function onMouseUp(event) {
  event.preventDefault();
  send({
    t: "mouseup",
    ...normalise(event),
    button: BUTTONS[event.button] || "left",
  });
}

function onWheel(event) {
  event.preventDefault();
  send({ t: "wheel", ...normalise(event), dx: event.deltaX, dy: event.deltaY });
}

// Keys the host browser would otherwise act on itself.
const SWALLOW = new Set([
  "Tab",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  " ",
  "Backspace",
  "Enter",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

function onKeyDown(event) {
  // Let the user keep browser-level shortcuts like Cmd+R and Cmd+L.
  if (event.metaKey || event.ctrlKey) return;
  if (SWALLOW.has(event.key)) event.preventDefault();
  send({ t: "keydown", key: event.key });
}

function onKeyUp(event) {
  if (event.metaKey || event.ctrlKey) return;
  send({ t: "keyup", key: event.key });
}

function onPaste(event) {
  const text = event.clipboardData?.getData("text");
  if (text) {
    event.preventDefault();
    send({ t: "text", value: text });
  }
}

function navigate(target) {
  const value = /^https?:\/\//i.test(target) ? target : `https://${target}`;
  send({ t: "navigate", url: value });
}
</script>

<template>
  <div class="remote">
    <header class="bar">
      <div class="nav-buttons">
        <button title="Back" @click="send({ t: 'back' })">←</button>
        <button title="Forward" @click="send({ t: 'forward' })">→</button>
        <button title="Reload" @click="send({ t: 'reload' })">↻</button>
      </div>

      <input
        class="address"
        :value="currentUrl"
        spellcheck="false"
        @keydown.enter="navigate($event.target.value)"
      />

      <span v-if="status === 'live' && !session?.embedUrl" class="fps"
        >{{ fps }} fps</span
      >
      <button class="close" @click="emit('close')">Close session</button>
    </header>

    <!-- Hosted provider: it serves its own embeddable page. -->
    <iframe
      v-if="session?.embedUrl"
      :src="session.embedUrl"
      class="hosted"
      allow="
        autoplay;
        fullscreen;
        clipboard-read;
        clipboard-write;
        camera;
        microphone;
      "
    />

    <!-- Local provider: raw frame stream on a canvas. -->
    <div
      v-else
      ref="stage"
      class="stage"
      tabindex="0"
      @mousemove="onMouseMove"
      @mousedown="onMouseDown"
      @mouseup="onMouseUp"
      @contextmenu.prevent
      @wheel.prevent="onWheel"
      @keydown="onKeyDown"
      @keyup="onKeyUp"
      @paste="onPaste"
    >
      <canvas ref="canvas" width="1280" height="720" />

      <div v-if="status === 'starting'" class="overlay">
        <div class="spinner" />
        <p>Launching a browser on the server…</p>
        <small>Cold start takes a few seconds</small>
      </div>

      <div v-else-if="status === 'error'" class="overlay error">
        <p>{{ errorMessage }}</p>
        <button @click="emit('close')">Back</button>
      </div>

      <div v-else-if="status === 'closed'" class="overlay">
        <p>Session ended</p>
        <small>Idle sessions are reclaimed automatically</small>
        <button @click="emit('close')">Back</button>
      </div>
    </div>

    <p class="hint">
      Real Chromium running server-side — click and type as normal. Frames are
      JPEG over WebSocket, so expect video-grade text. Session is reclaimed
      after inactivity.
    </p>
  </div>
</template>

<style scoped>
.remote {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.bar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 10px;
}

.nav-buttons {
  display: flex;
  gap: 0.25rem;
}

.bar button {
  background: var(--surface-3);
  border: 1px solid var(--border);
  color: var(--text);
  border-radius: 7px;
  padding: 0.35rem 0.6rem;
  cursor: pointer;
  font-size: 0.9rem;
}

.bar button:hover {
  background: var(--surface-4);
}

.address {
  flex: 1;
  min-width: 0;
  background: var(--surface-1);
  border: 1px solid var(--border);
  color: var(--text);
  border-radius: 7px;
  padding: 0.4rem 0.7rem;
  font-family: var(--mono);
  font-size: 0.82rem;
}

.fps {
  font-family: var(--mono);
  font-size: 0.72rem;
  color: var(--text-dim);
  white-space: nowrap;
}

.close {
  white-space: nowrap;
}

.stage {
  position: relative;
  background: #000;
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
  aspect-ratio: 16 / 9;
  cursor: default;
  outline: none;
}

.stage:focus-visible {
  border-color: var(--accent);
}

.stage canvas {
  width: 100%;
  height: 100%;
  display: block;
}

.hosted {
  width: 100%;
  aspect-ratio: 16 / 9;
  border: 1px solid var(--border);
  border-radius: 10px;
}

.overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.6rem;
  background: rgba(0, 0, 0, 0.82);
  color: #fff;
  text-align: center;
  padding: 1rem;
}

.overlay small {
  color: #999;
}

.overlay.error p {
  color: var(--danger);
  max-width: 44ch;
}

.spinner {
  width: 26px;
  height: 26px;
  border: 2px solid rgba(255, 255, 255, 0.2);
  border-top-color: #fff;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.hint {
  font-size: 0.78rem;
  color: var(--text-dim);
  margin: 0;
}
</style>
