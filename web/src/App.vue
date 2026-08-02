<script setup>
import { ref } from "vue";
import RemoteSession from "./components/RemoteSession.vue";

const input = ref("");
const target = ref(null);
// Bumped on every launch so RemoteSession remounts and starts a fresh session
// even when the URL is unchanged.
const sessionKey = ref(0);

const samples = ["github.com", "google.com", "en.wikipedia.org/wiki/Iframe"];

function launch(value = input.value) {
  const trimmed = value.trim();
  if (!trimmed) return;
  input.value = trimmed;
  target.value = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  sessionKey.value++;
}
</script>

<template>
  <div class="app">
    <header class="head">
      <h1>remote browser</h1>
      <p>
        Opens any URL in a real Chromium running on the server and streams it back,
        so framing restrictions never apply. Each session costs a CPU core, so one
        only starts when you ask.
      </p>
    </header>

    <form class="search" @submit.prevent="launch()">
      <input
        v-model="input"
        type="text"
        placeholder="Enter any URL — github.com, google.com…"
        spellcheck="false"
        autocapitalize="off"
      />
      <button type="submit">Open session</button>
    </form>

    <div class="samples">
      <button v-for="s in samples" :key="s" @click="launch(s)">{{ s }}</button>
    </div>

    <main v-if="target">
      <RemoteSession :key="sessionKey" :url="target" @close="target = null" />
    </main>
  </div>
</template>

<style scoped>
.app {
  max-width: 1100px;
  margin: 0 auto;
  padding: 2.5rem 1.5rem 4rem;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

.head h1 {
  font-size: 1.5rem;
  margin: 0 0 0.4rem;
  letter-spacing: -0.02em;
}

.head p {
  margin: 0;
  color: var(--text-dim);
  font-size: 0.9rem;
  max-width: 62ch;
  line-height: 1.6;
}

.search {
  display: flex;
  gap: 0.5rem;
}

.search input {
  flex: 1;
  min-width: 0;
  background: var(--surface-2);
  border: 1px solid var(--border);
  color: var(--text);
  border-radius: 9px;
  padding: 0.7rem 0.9rem;
  font-size: 0.95rem;
}

.search input:focus {
  outline: none;
  border-color: var(--accent);
}

.search button {
  background: var(--accent);
  color: #fff;
  border: 0;
  border-radius: 9px;
  padding: 0.7rem 1.4rem;
  font-size: 0.95rem;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
}

.samples {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}

.samples button {
  background: var(--surface-2);
  border: 1px solid var(--border);
  color: var(--text-dim);
  border-radius: 999px;
  padding: 0.35rem 0.8rem;
  font-size: 0.78rem;
  cursor: pointer;
}

.samples button:hover {
  border-color: var(--accent);
  color: var(--text);
}
</style>
