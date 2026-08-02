import dns from "node:dns/promises";
import net from "node:net";
import { config } from "../config.js";

/**
 * Server-Side Request Forgery guard.
 *
 * Session URLs come from the client and are loaded by a browser running on our
 * machine, with the result streamed back to that same client. Without this,
 * anyone can point us at http://169.254.169.254/ (cloud instance metadata, i.e.
 * credentials) or at internal services on the host network and read the
 * response off the video stream.
 *
 * The rule that makes this work: resolve the hostname ourselves and check the
 * resulting IP, not the name. "localtest.me" and countless other public names
 * resolve to 127.0.0.1.
 *
 * Known gap: this validates the URL we hand to Chromium, but Chromium follows
 * redirects itself, so a public URL that 302s to an internal address is still
 * reachable. Closing that needs request interception (page.route) inside the
 * session, not a check here.
 */

export class UnsafeUrlError extends Error {
  constructor(message) {
    super(message);
    this.name = "UnsafeUrlError";
    this.status = 400;
  }
}

function isBlockedV4(ip) {
  const [a, b] = ip.split(".").map(Number);
  if (a === 0) return true; // "this" network
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 0) return true; // IETF protocol assignments
  if (a === 192 && b === 168) return true; // private
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

/**
 * Expand any IPv6 textual form to its eight 16-bit groups, including the
 * embedded-IPv4 notations.
 */
function expandV6(input) {
  let addr = input.toLowerCase().split("%")[0]; // strip zone id

  // Rewrite a trailing dotted-quad into two hex groups so the rest of the
  // parser only deals with hex.
  const embedded = addr.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (embedded) {
    const [a, b, c, d] = embedded[1].split(".").map(Number);
    addr =
      addr.slice(0, embedded.index) +
      (((a << 8) | b) >>> 0).toString(16) +
      ":" +
      (((c << 8) | d) >>> 0).toString(16);
  }

  const [head, tail] = addr.split("::");
  const headGroups = head ? head.split(":").filter(Boolean) : [];
  const tailGroups = tail ? tail.split(":").filter(Boolean) : [];
  const fill = Math.max(0, 8 - headGroups.length - tailGroups.length);

  const groups = [
    ...headGroups,
    ...(addr.includes("::") ? Array(fill).fill("0") : []),
    ...tailGroups,
  ].map((g) => parseInt(g, 16) & 0xffff);

  while (groups.length < 8) groups.push(0);
  return groups.slice(0, 8);
}

/**
 * If the address is one of the IPv4-in-IPv6 forms, return the embedded IPv4.
 * All three tunnel the v4 blocklist through v6 if left undecoded:
 *   ::ffff:a.b.c.d    v4-mapped      groups[5] = 0xffff
 *   ::ffff:0:a.b.c.d  v4-translated  groups[4] = 0xffff
 *   ::a.b.c.d         v4-compatible  first six groups zero
 */
function embeddedV4(groups) {
  const leadingZero = (n) => groups.slice(0, n).every((g) => g === 0);

  const mapped = leadingZero(5) && groups[5] === 0xffff;
  const translated = leadingZero(4) && groups[4] === 0xffff && groups[5] === 0;
  const compatible = leadingZero(6) && !(groups[6] === 0 && groups[7] <= 1);

  if (!mapped && !translated && !compatible) return null;

  return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join(".");
}

function isBlockedV6(ip) {
  const groups = expandV6(ip);

  // :: (unspecified) and ::1 (loopback)
  if (groups.every((g) => g === 0)) return true;
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true;

  // Decoded IPv4 must be checked against the allowlist too, or a range that
  // was explicitly permitted stays blocked when reached via its v6 form.
  const v4 = embeddedV4(groups);
  if (v4) return isAllowlisted(v4) ? false : isBlockedV4(v4);

  const head = groups[0];
  if ((head & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((head & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((head & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

/* ------------------------------------------------------------------ *
 * Allowlist escape hatch
 *
 * Some networks (corporate proxies, VPNs, container DNS, and notably any
 * setup that NATs external hosts into 198.18.0.0/15) legitimately resolve
 * public names to reserved ranges. Internal dashboards on a LAN are the
 * other real case.
 *
 * SSRF_ALLOW_CIDRS opens specific ranges back up. It is empty by default and
 * every entry you add is genuine SSRF surface — only widen it on a network
 * you control, and never on a public deployment that accepts arbitrary URLs.
 * ------------------------------------------------------------------ */

function ipToBigInt(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) {
    return ip.split(".").reduce((acc, oct) => (acc << 8n) | BigInt(Number(oct)), 0n);
  }
  return expandV6(ip).reduce((acc, g) => (acc << 16n) | BigInt(g), 0n);
}

function parseCidr(entry) {
  const [addr, bitsRaw] = entry.trim().split("/");
  const kind = net.isIP(addr);
  if (!kind) return null;
  const width = kind === 4 ? 32 : 128;
  const bits = bitsRaw === undefined ? width : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > width) return null;

  const mask = bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(width - bits);
  return { kind, network: ipToBigInt(addr) & mask, mask };
}

const ALLOWED_CIDRS = (config.ssrfAllowCidrs || [])
  .map(parseCidr)
  .filter(Boolean);

function isAllowlisted(ip) {
  const kind = net.isIP(ip);
  const value = ipToBigInt(ip);
  return ALLOWED_CIDRS.some((c) => c.kind === kind && (value & c.mask) === c.network);
}

function isBlockedIp(ip) {
  if (isAllowlisted(ip)) return false;
  const kind = net.isIP(ip);
  if (kind === 4) return isBlockedV4(ip);
  if (kind === 6) return isBlockedV6(ip);
  return true; // not an IP at all -> refuse
}

/**
 * Validate a single URL. Returns the parsed URL plus the resolved address we
 * verified, so the caller can pin the connection if it wants to.
 */
export async function assertSafeUrl(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw new UnsafeUrlError("Not a valid URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsafeUrlError(`Protocol ${url.protocol} is not allowed`);
  }

  // Credentials in a URL are a classic way to confuse downstream parsers.
  if (url.username || url.password) {
    throw new UnsafeUrlError("URLs with embedded credentials are not allowed");
  }

  const host = url.hostname.replace(/^\[|\]$/g, ""); // unwrap [::1]

  // A literal IP needs no DNS round trip.
  if (net.isIP(host)) {
    if (isBlockedIp(host)) throw new UnsafeUrlError("Target resolves to a private or reserved address");
    return { url, address: host };
  }

  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new UnsafeUrlError("Target resolves to a private or reserved address");
  }

  let records;
  try {
    records = await dns.lookup(host, { all: true });
  } catch {
    throw new UnsafeUrlError("Could not resolve host");
  }

  if (!records.length) throw new UnsafeUrlError("Could not resolve host");

  // Every address must be safe. A hostname with one public and one private
  // A record would otherwise be a coin flip at connect time.
  for (const { address } of records) {
    if (isBlockedIp(address)) {
      throw new UnsafeUrlError("Target resolves to a private or reserved address");
    }
  }

  return { url, address: records[0].address };
}
