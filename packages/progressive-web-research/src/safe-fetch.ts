// Safe Web fetch transport (ADR-0015 §5/§6, Web Research spec §5). Owns ALL
// networking — extraction never touches the network. Per hop: static URL
// admission → DNS resolve → every address validated → pinned connect with the
// original Host/TLS SNI. `direct_then_socks5` falls back exactly once, only
// on transport failure (shared classifier; any HTTP response — including
// 4xx/5xx — is a semantic result, never a fallback trigger). Bodies are
// bounded while streaming; Content-Length is a hint, never a trust anchor.
import net from "node:net";
import tls from "node:tls";
import {
  type ExtensionOutboundPolicy,
  isTransportFailure,
  type Socks5ProxyConfig,
} from "@pcms/extensions";
import { SocksClient } from "socks";
import {
  Agent,
  type Dispatcher,
  type Response as UndiciResponse,
  fetch as undiciFetch,
} from "undici";
import { ResearchError } from "./errors.js";
import { type ParsedTarget, parsePublicHttpUrl, resolveAndPin } from "./url-policy.js";

export interface SafeFetchSettings {
  readonly redirectLimit: number;
  readonly maxResponseBytes: number;
  readonly maxDecompressedBytes: number;
  readonly totalTimeoutMs: number;
  readonly allowedPorts: readonly number[];
}

export interface SafeFetchResult {
  readonly requestUrl: string;
  readonly finalUrl: string;
  readonly status: number;
  readonly contentType: string;
  readonly bytes: Buffer;
  readonly networkPath: "direct" | "socks5" | "direct_then_socks5";
}

/** Test-only escape hatch: lets the SSRF integration corpus serve private
 * ranges from a local http server. Never exposed through config/operations. */
export interface SafeFetchOptions {
  readonly allowPrivateTargets?: boolean;
}

const CONNECT_TIMEOUT_MS = 10_000;

export async function safeFetch(
  rawUrl: string,
  settings: SafeFetchSettings,
  policy: ExtensionOutboundPolicy,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  let target: ParsedTarget = parsePublicHttpUrl(rawUrl, settings.allowedPorts, options);
  const networkPath = policy.mode;
  let dispatcher: Dispatcher | null = null;
  try {
    for (let hop = 0; hop <= settings.redirectLimit; hop += 1) {
      if (!options.allowPrivateTargets && policy.mode !== "socks5") {
        // Prove the host is public before dialing. socks5 with remote DNS is
        // the documented exception (residual rebinding risk, spec §6).
        await resolveAndPin(target.hostname);
      }
      dispatcher = buildDispatcher(policy, options);
      let response: UndiciResponse;
      try {
        response = await undiciFetch(target.url.toString(), {
          redirect: "manual",
          dispatcher,
          signal: AbortSignal.timeout(settings.totalTimeoutMs),
          headers: { "user-agent": userAgent(), "accept-encoding": "gzip, deflate, br" },
        });
      } catch (cause) {
        if (cause instanceof Error && cause.name === "AbortError") {
          throw new ResearchError("RESEARCH_FETCH_TIMEOUT", "research fetch: request timed out", {
            cause,
          });
        }
        if (policy.mode !== "direct_then_socks5" || !isTransportFailure(cause)) {
          throw researchNetworkError(cause);
        }
        // Exactly one proxy fallback, transport failure only. The direct
        // dispatcher's pool is spent — swap in the SOCKS dispatcher for the
        // retry (and the finalizer's close).
        await dispatcher.close().catch(() => undefined);
        dispatcher = buildDispatcher({ ...policy, mode: "socks5" }, options);
        try {
          response = await undiciFetch(target.url.toString(), {
            redirect: "manual",
            dispatcher,
            signal: AbortSignal.timeout(settings.totalTimeoutMs),
            headers: { "user-agent": userAgent(), "accept-encoding": "gzip, deflate, br" },
          });
        } catch (fallbackCause) {
          throw researchNetworkError(fallbackCause);
        }
      }
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location !== null) {
        await drainAndClose(response, dispatcher);
        dispatcher = null;
        // Every hop re-enters full admission (scheme/port/credentials/DNS/IP).
        target = parsePublicHttpUrl(
          new URL(location, target.url).toString(),
          settings.allowedPorts,
          options,
        );
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        throw new ResearchError(
          "RESEARCH_FETCH_HTTP_BLOCKED",
          `research fetch: target responded HTTP ${String(response.status)} (blocked/auth required)`,
        );
      }
      if (response.status === 404 || response.status === 410) {
        throw new ResearchError(
          "RESEARCH_FETCH_HTTP_NOT_FOUND",
          `research fetch: target responded HTTP ${String(response.status)} (not found)`,
        );
      }
      if (response.status === 429) {
        throw new ResearchError(
          "RESEARCH_FETCH_HTTP_RATE_LIMITED",
          "research fetch: target rate-limited the fetch (HTTP 429)",
        );
      }
      if (response.status >= 500) {
        throw new ResearchError(
          "RESEARCH_FETCH_HTTP_UPSTREAM_ERROR",
          `research fetch: target server error (HTTP ${String(response.status)})`,
        );
      }
      if (response.status < 200 || response.status >= 300) {
        throw new ResearchError(
          "RESEARCH_FETCH_HTTP_UPSTREAM_ERROR",
          `research fetch: unexpected HTTP ${String(response.status)}`,
        );
      }
      const contentLength = Number(response.headers.get("content-length") ?? "0");
      if (Number.isFinite(contentLength) && contentLength > settings.maxResponseBytes) {
        throw new ResearchError(
          "RESEARCH_FETCH_CONTENT_TOO_LARGE",
          `research fetch: response exceeds the ${String(settings.maxResponseBytes)} byte cap`,
        );
      }
      const bytes = await readBounded(response, settings.maxDecompressedBytes);
      return {
        requestUrl: rawUrl,
        finalUrl: target.url.toString(),
        status: response.status,
        contentType: (
          response.headers.get("content-type") ?? "application/octet-stream"
        ).toLowerCase(),
        bytes,
        networkPath,
      };
    }
    throw new ResearchError(
      "RESEARCH_FETCH_NETWORK_FAILED",
      `research fetch: redirect limit (${String(settings.redirectLimit)}) exceeded`,
    );
  } finally {
    await dispatcher?.close().catch(() => undefined);
  }
}

function researchNetworkError(cause: unknown): ResearchError {
  if (cause instanceof ResearchError) return cause;
  const message = cause instanceof Error ? cause.message : String(cause);
  return new ResearchError(
    "RESEARCH_FETCH_NETWORK_FAILED",
    `research fetch: transport failure (${message})`,
    { cause },
  );
}

export function userAgent(): string {
  // Product identity over disguise: no browser impersonation, no Googlebot.
  return "ProgressiveCMS-WebResearch/1.0";
}

async function readBounded(response: UndiciResponse, cap: number): Promise<Buffer> {
  if (response.body === null) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of response.body) {
      const piece = Buffer.from(chunk as Uint8Array);
      total += piece.length;
      if (total > cap) {
        throw new ResearchError(
          "RESEARCH_FETCH_CONTENT_TOO_LARGE",
          `research fetch: decompressed body exceeds the ${String(cap)} byte cap`,
        );
      }
      chunks.push(piece);
    }
  } catch (cause) {
    // Aborting mid-stream: cancel so the socket cannot linger.
    await response.body.cancel().catch(() => undefined);
    throw cause;
  }
  return Buffer.concat(chunks);
}

/** Undici decompresses transparently; on abort mid-stream the socket must not linger. */
async function drainAndClose(response: UndiciResponse, dispatcher: Dispatcher): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
  await dispatcher.close().catch(() => undefined);
}

/**
 * Dispatcher whose connector reproduces the outbound client's discipline with
 * SSRF hardening: resolve → validate → dial the PINNED address; TLS SNI and
 * the HTTP Host header keep the original hostname (undici derives them from
 * the request URL). Through SOCKS5 the pinned IP is the destination (ATYP=IP);
 * with remote_dns the hostname is handed to the proxy instead — the documented
 * socks5h exception for hosts unreachable via local DNS.
 */
function buildDispatcher(policy: ExtensionOutboundPolicy, options: SafeFetchOptions): Dispatcher {
  return new Agent({
    connect: async ({ hostname, port, protocol }, callback) => {
      const destPort = Number(port) || (protocol === "https:" ? 443 : 80);
      try {
        let socket: net.Socket;
        if (policy.mode === "direct" || policy.proxy === undefined) {
          const destination = options.allowPrivateTargets
            ? { host: hostname, port: destPort }
            : await pinnedDestination(hostname, destPort);
          socket = await dialDirect(destination.host, destination.port);
        } else {
          const destination =
            policy.proxy.remoteDns && !options.allowPrivateTargets
              ? { host: hostname, port: destPort }
              : options.allowPrivateTargets
                ? { host: hostname, port: destPort }
                : await pinnedDestination(hostname, destPort);
          socket = await dialSocks(policy.proxy, destination);
        }
        if (protocol === "https:") {
          const tlsSocket = tls.connect({ socket, servername: hostname });
          await new Promise<void>((resolve, reject) => {
            const onSecure = (): void => {
              cleanup();
              resolve();
            };
            const onError = (cause: unknown): void => {
              cleanup();
              reject(cause);
            };
            const cleanup = (): void => {
              tlsSocket.off("secureConnect", onSecure);
              tlsSocket.off("error", onError);
            };
            tlsSocket.once("secureConnect", onSecure);
            tlsSocket.once("error", onError);
          });
          callback(null, tlsSocket);
        } else {
          callback(null, socket);
        }
      } catch (cause) {
        callback(cause instanceof Error ? cause : new Error(String(cause)), null);
      }
    },
    connectTimeout: CONNECT_TIMEOUT_MS,
  });
}

async function pinnedDestination(
  hostname: string,
  port: number,
): Promise<{ host: string; port: number }> {
  const pinned = await resolveAndPin(hostname);
  return { host: pinned.host, port };
}

function dialDirect(host: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const onConnect = (): void => {
      cleanup();
      resolve(socket);
    };
    const onError = (cause: unknown): void => {
      cleanup();
      socket.destroy();
      reject(cause);
    };
    const cleanup = (): void => {
      socket.off("connect", onConnect);
      socket.off("error", onError);
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
}

function dialSocks(
  proxy: Socks5ProxyConfig,
  destination: { host: string; port: number },
): Promise<net.Socket> {
  return SocksClient.createConnection({
    proxy: {
      host: proxy.host,
      port: proxy.port,
      type: 5,
      ...(proxy.username !== undefined
        ? { userId: proxy.username, password: proxy.password ?? "" }
        : {}),
    },
    command: "connect",
    destination,
    timeout: CONNECT_TIMEOUT_MS,
  }).then(
    ({ socket }) => socket,
    (cause: unknown) => {
      throw cause;
    },
  );
}

/** Charset resolution for text/json/xml passthrough (HTML feeds JSDOM bytes). */
export function decodeBody(bytes: Buffer, contentType: string): { text: string; charset: string } {
  const bomCharsets: readonly (readonly [Buffer, string])[] = [
    [Buffer.from([0xef, 0xbb, 0xbf]), "utf-8"],
    [Buffer.from([0xff, 0xfe]), "utf-16le"],
    [Buffer.from([0xfe, 0xff]), "utf-16be"],
  ];
  const headerCharset = /charset=([^\s;]+)/i.exec(contentType)?.[1]?.replace(/^"|"$/g, "");
  const metaCharset =
    headerCharset === undefined
      ? /charset\s*=\s*["']?([\w-]+)/i.exec(bytes.subarray(0, 4096).toString("latin1"))?.[1]
      : undefined;
  const charset = (headerCharset ?? metaCharset ?? "").toLowerCase();
  for (const [bom, label] of bomCharsets) {
    if (bytes.subarray(0, bom.length).equals(bom)) {
      return { text: decode(bytes.subarray(bom.length), label), charset: label };
    }
  }
  if (charset !== "") {
    try {
      return { text: decode(bytes, charset), charset };
    } catch {
      // unknown label → utf-8 fallback below
    }
  }
  return { text: decode(bytes, "utf-8"), charset: "utf-8" };
}

function decode(bytes: Buffer, charset: string): string {
  return new TextDecoder(charset, { fatal: false }).decode(bytes);
}
