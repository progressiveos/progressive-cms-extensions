// URL admission + SSRF address policy for the research fetcher (ADR-0015 §5,
// Web Research spec §5/§8). Checks operate on parsed IP bytes, never string
// prefixes. Discipline: validate statically → resolve → validate EVERY
// resolved address → pin one address for the connection (original Host/SNI
// preserved upstream). Every redirect hop goes through the same path.

import dns from "node:dns";
import net from "node:net";
import { ResearchError } from "./errors.js";

export interface ParsedTarget {
  readonly url: URL;
  readonly port: number;
  readonly hostname: string;
}

const HOSTNAME_BLOCKED_SUFFIXES = [".local", ".localhost", ".internal"];

/** Static admission before any network activity. The private-target escape
 * hatch exists ONLY for the SSRF test corpus serving fixtures from a local
 * server — the extension never passes it from configuration. */
export function parsePublicHttpUrl(
  raw: string,
  allowedPorts: readonly number[],
  options: { readonly allowPrivateTargets?: boolean } = {},
): ParsedTarget {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ResearchError(
      "RESEARCH_FETCH_URL_SCHEME",
      `research fetch: URL is not parseable: ${truncate(raw)}`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ResearchError(
      "RESEARCH_FETCH_URL_SCHEME",
      `research fetch: only http and https URLs are fetchable (got ${url.protocol})`,
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new ResearchError(
      "RESEARCH_FETCH_URL_CREDENTIALS",
      "research fetch: URLs with embedded credentials are not supported",
    );
  }
  const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  if (!Number.isInteger(port) || !allowedPorts.includes(port)) {
    throw new ResearchError(
      "RESEARCH_FETCH_URL_PORT",
      `research fetch: port ${String(url.port || port)} is not in the allowed set (${allowedPorts.join(", ")})`,
    );
  }
  // URL.hostname keeps brackets around IPv6 literals — policy checks use the
  // bare address.
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (!options.allowPrivateTargets) {
    if (isBlockedHostname(hostname)) {
      throw new ResearchError(
        "RESEARCH_FETCH_URL_HOST",
        `research fetch: host "${hostname}" is not a public DNS name`,
      );
    }
    // Literal-IP hosts bypass DNS — validate the bytes right here.
    if (net.isIP(hostname) !== 0 && isBlockedIpString(hostname)) {
      throw new ResearchError(
        "RESEARCH_FETCH_SSRF_BLOCKED",
        `research fetch: address "${hostname}" is in a blocked range`,
      );
    }
  }
  return { url, port, hostname };
}

/** Hostname-shape policy (used for literal fetch targets and browser subresources). */
export function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host === "" || HOSTNAME_BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  return false;
}

/** True when the address must never be dialed: loopback/private/CGNAT/
 * link-local/multicast/unspecified/mapped plus the IETF-reserved ranges.
 * The range list is kept IDENTICAL to packages/integrations/src/ssrf.ts
 * (single blocklist policy): 192.0.0.0/24, TEST-NET-1/2/3, 198.18.0.0/15,
 * NAT64 64:ff9b::/96, 2001:db8::/32, IPv4-compatible ::/96. */
export function isBlockedIpBytes(ip: readonly number[]): boolean {
  if (ip.length === 4) {
    const a = ip[0] ?? 255;
    const b = ip[1] ?? 255;
    const c = ip[2] ?? 255;
    return (
      a === 0 || // 0.0.0.0/8 "this network" (+ unspecified)
      a === 10 || // RFC1918
      a === 127 || // loopback (incl. metadata-style aliases)
      (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10 (incl. cloud-internal ranges)
      (a === 169 && b === 254) || // link-local 169.254/16 (cloud metadata 169.254.169.254)
      (a === 172 && b >= 16 && b <= 31) || // RFC1918
      (a === 192 && b === 168) || // RFC1918
      (a === 192 && b === 0 && c === 0) || // 192.0.0.0/24 IETF protocol assignments
      (a === 192 && b === 0 && c === 2) || // TEST-NET-1 192.0.2.0/24
      (a === 198 && (b === 18 || b === 19)) || // benchmarking 198.18.0.0/15
      (a === 198 && b === 51 && c === 100) || // TEST-NET-2 198.51.100.0/24
      (a === 203 && b === 0 && c === 113) || // TEST-NET-3 203.0.113.0/24
      a >= 224 // multicast 224/4 + reserved 240/4
    );
  }
  if (ip.length === 16) {
    // IPv4-mapped (::ffff:a.b.c.d) — judge the embedded v4 bytes.
    const v4 = ipv4MappedBytes(ip);
    if (v4 !== null) return isBlockedIpBytes(v4);
    const first = ip[0] ?? 255;
    if (first === 0xff) return true; // ff00::/8 multicast
    if (first === 0xfe && ((ip[1] ?? 255) & 0xc0) === 0x80) return true; // fe80::/10 link-local
    if ((first & 0xfe) === 0xfc) return true; // fc00::/7 ULA
    if (ip.every((byte) => byte === 0)) return true; // :: unspecified
    // ::1 loopback = 15 zero groups then 1.
    if (ip.slice(0, 15).every((byte) => byte === 0) && ip[15] === 1) return true;
    // ::/96 IPv4-compatible (deprecated RFC 4291) — fail-secure block.
    if (ip.slice(0, 12).every((byte) => byte === 0)) return true;
    // NAT64 64:ff9b::/96 (RFC 6052 transit) — fail-secure prefix block.
    if (first === 0x00 && ip[1] === 0x64 && ip[2] === 0xff && ip[3] === 0x9b) return true;
    // 2001:db8::/32 documentation range.
    if (first === 0x20 && ip[1] === 0x01 && ip[2] === 0x0d && ip[3] === 0xb8) return true;
    return false;
  }
  return true;
}

function ipv4MappedBytes(ip: readonly number[]): readonly number[] | null {
  const prefixZeros = ip.slice(0, 10).every((byte) => byte === 0);
  const ff = ip[10] === 0xff && ip[11] === 0xff;
  return prefixZeros && ff ? ip.slice(12, 16) : null;
}

/** Address-literal check only: non-IP strings (DNS names) are NOT blocked
 * here — hostname policy is `isBlockedHostname`'s job. Callers that need
 * both must combine the two checks explicitly. */
export function isBlockedIpString(value: string): boolean {
  if (net.isIPv4(value)) return isBlockedIpBytes(value.split(".").map(Number));
  if (net.isIPv6(value)) return isBlockedIpBytes(expandIpv6(value));
  return false;
}

/** Expands an IPv6 literal into 16 bytes (handles :: compression). */
export function expandIpv6(value: string): number[] {
  let head = value;
  // Zone ids are irrelevant for policy.
  const percent = head.indexOf("%");
  if (percent >= 0) head = head.slice(0, percent);
  const parts = head.split("::");
  if (parts.length > 2) return new Array<number>(16).fill(255); // malformed → blocked
  const left = parts[0] === "" ? [] : (parts[0] ?? "").split(":");
  const right =
    parts.length === 2 && parts[1] !== undefined && parts[1] !== "" ? parts[1].split(":") : [];
  // IPv4-mapped tails (::ffff:192.168.0.1) — the dotted quad is ONE 32-bit
  // group pair, not two hex groups.
  if (right.length > 0 && (right[right.length - 1] ?? "").includes(".")) {
    const quad = (right.pop() ?? "").split(".").map(Number);
    if (quad.length !== 4 || quad.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return new Array<number>(16).fill(255);
    }
    right.push((((quad[0] ?? 0) << 8) | (quad[1] ?? 0)).toString(16));
    right.push((((quad[2] ?? 0) << 8) | (quad[3] ?? 0)).toString(16));
  }
  const missing = 8 - (left.length + right.length);
  if (parts.length === 1 && missing !== 0) return new Array<number>(16).fill(255);
  const groups = [...left, ...new Array<string>(Math.max(missing, 0)).fill("0"), ...right];
  if (groups.length !== 8) return new Array<number>(16).fill(255);
  const bytes: number[] = [];
  for (const group of groups) {
    const value16 = Number.parseInt(group, 16);
    if (!Number.isInteger(value16) || value16 < 0 || value16 > 0xffff) {
      return new Array<number>(16).fill(255);
    }
    bytes.push(value16 >> 8, value16 & 0xff);
  }
  return bytes;
}

export interface PinnedAddress {
  readonly host: string;
  readonly family: 4 | 6;
}

export type DnsLookup = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<readonly { address: string; family: number }[]>;

/**
 * Resolves a hostname and proves every resolved address is public before
 * pinning one. Strict mode: a single blocked address rejects the host —
 * an adversary controlling one record must not get a private-range probe.
 */
export async function resolveAndPin(
  hostname: string,
  lookup: DnsLookup = (host, options) =>
    dns.promises.lookup(host, options) as unknown as Promise<
      readonly { address: string; family: number }[]
    >,
): Promise<PinnedAddress> {
  if (net.isIP(hostname) !== 0) {
    if (isBlockedIpString(hostname)) {
      throw new ResearchError(
        "RESEARCH_FETCH_SSRF_BLOCKED",
        `research fetch: address is in a blocked range`,
      );
    }
    return { host: hostname, family: net.isIPv4(hostname) ? 4 : 6 };
  }
  let records: readonly { address: string; family: number }[];
  try {
    records = await lookup(hostname, { all: true, verbatim: true });
  } catch (cause) {
    throw new ResearchError(
      "RESEARCH_FETCH_NETWORK_FAILED",
      `research fetch: DNS resolution failed for "${hostname}"`,
      { cause },
    );
  }
  if (records.length === 0) {
    throw new ResearchError(
      "RESEARCH_FETCH_NETWORK_FAILED",
      `research fetch: no addresses resolved for "${hostname}"`,
    );
  }
  for (const record of records) {
    if (isBlockedIpString(record.address)) {
      throw new ResearchError(
        "RESEARCH_FETCH_SSRF_BLOCKED",
        `research fetch: "${hostname}" resolves to a blocked address (${record.address})`,
      );
    }
  }
  const pinned = records[0];
  if (pinned === undefined) {
    throw new ResearchError(
      "RESEARCH_FETCH_NETWORK_FAILED",
      `research fetch: no addresses resolved for "${hostname}"`,
    );
  }
  return { host: pinned.address, family: pinned.family === 6 ? 6 : 4 };
}

function truncate(value: string): string {
  return value.length > 200 ? `${value.slice(0, 200)}…` : value;
}
