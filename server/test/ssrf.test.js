import test from "node:test";
import assert from "node:assert/strict";
import { assertSafeUrl, UnsafeUrlError } from "../src/lib/ssrf.js";

/**
 * Run with:  node --test server/test/
 *
 * Hostnames here are literal IPs so the tests never depend on DNS.
 */

async function rejects(url) {
  await assert.rejects(() => assertSafeUrl(url), UnsafeUrlError, `should reject ${url}`);
}

async function accepts(url) {
  await assert.doesNotReject(() => assertSafeUrl(url), `should accept ${url}`);
}

test("rejects non-http protocols", async () => {
  await rejects("file:///etc/passwd");
  await rejects("gopher://127.0.0.1:6379/_INFO");
  await rejects("ftp://example.com/x");
  await rejects("javascript:alert(1)");
});

test("rejects loopback and private IPv4", async () => {
  await rejects("http://127.0.0.1/");
  await rejects("http://127.1.2.3/");
  await rejects("http://10.0.0.5/");
  await rejects("http://192.168.1.1/");
  await rejects("http://172.16.0.1/");
  await rejects("http://172.31.255.254/");
  await rejects("http://0.0.0.0/");
});

test("rejects cloud instance metadata", async () => {
  await rejects("http://169.254.169.254/latest/meta-data/");
  await rejects("http://169.254.170.2/v2/credentials");
});

test("rejects CGNAT, benchmarking, multicast", async () => {
  await rejects("http://100.64.0.1/");
  await rejects("http://198.18.0.1/");
  await rejects("http://224.0.0.1/");
  await rejects("http://255.255.255.255/");
});

test("rejects IPv6 loopback and private ranges", async () => {
  await rejects("http://[::1]/");
  await rejects("http://[::]/");
  await rejects("http://[fc00::1]/");
  await rejects("http://[fd12:3456::1]/");
  await rejects("http://[fe80::1]/");
  await rejects("http://[ff02::1]/");
});

test("rejects IPv4 tunnelled through every IPv6 embedding form", async () => {
  // v4-mapped
  await rejects("http://[::ffff:127.0.0.1]/");
  await rejects("http://[::ffff:169.254.169.254]/");
  // v4-translated — the form this environment's resolver actually returns
  await rejects("http://[::ffff:0:127.0.0.1]/");
  await rejects("http://[::ffff:0:7f00:1]/");
  // v4-compatible
  await rejects("http://[::127.0.0.1]/");
  // hex spelling of a v4-mapped loopback
  await rejects("http://[::ffff:7f00:1]/");
});

test("rejects embedded credentials", async () => {
  await rejects("http://user:pass@93.184.216.34/");
});

test("rejects localhost-ish names without DNS", async () => {
  await rejects("http://localhost/");
  await rejects("http://foo.localhost/");
  await rejects("http://printer.local/");
});

test("accepts ordinary public addresses", async () => {
  await accepts("http://93.184.216.34/");
  await accepts("https://1.1.1.1/");
  await accepts("http://[2606:2800:220:1:248:1893:25c8:1946]/");
});
