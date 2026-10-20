// Typed Web Research errors (ADR-0015, Web Research spec §6). Stable code
// families travel through the central error envelope unchanged (code is the
// identity; HTTP status is a presentation hint). Messages are written for
// agents/operators and never contain secrets, request credentials or raw
// provider payloads.

export type ResearchErrorCode =
  | "RESEARCH_CONFIG_MISSING"
  | "RESEARCH_CONFIG_INVALID"
  | "RESEARCH_SEARCH_QUERY_INVALID"
  | "RESEARCH_SEARCH_CONFIG_MISSING"
  | "RESEARCH_SEARCH_AUTH_FAILED"
  | "RESEARCH_SEARCH_RATE_LIMITED"
  | "RESEARCH_SEARCH_BALANCE_OR_QUOTA"
  | "RESEARCH_SEARCH_PROVIDER_ERROR"
  | "RESEARCH_SEARCH_NETWORK_FAILED"
  | "RESEARCH_SEARCH_TIMEOUT"
  | "RESEARCH_SEARCH_RESPONSE_INVALID"
  | "RESEARCH_FETCH_URL_SCHEME"
  | "RESEARCH_FETCH_URL_CREDENTIALS"
  | "RESEARCH_FETCH_URL_PORT"
  | "RESEARCH_FETCH_URL_HOST"
  | "RESEARCH_FETCH_SSRF_BLOCKED"
  | "RESEARCH_FETCH_NETWORK_FAILED"
  | "RESEARCH_FETCH_TIMEOUT"
  | "RESEARCH_FETCH_HTTP_BLOCKED"
  | "RESEARCH_FETCH_HTTP_NOT_FOUND"
  | "RESEARCH_FETCH_HTTP_RATE_LIMITED"
  | "RESEARCH_FETCH_HTTP_UPSTREAM_ERROR"
  | "RESEARCH_FETCH_CONTENT_UNSUPPORTED_TYPE"
  | "RESEARCH_FETCH_CONTENT_TOO_LARGE"
  | "RESEARCH_FETCH_CONTENT_CHARSET"
  | "RESEARCH_FETCH_EXTRACT_FAILED"
  | "RESEARCH_FETCH_BROWSER_UNAVAILABLE"
  | "RESEARCH_FETCH_BROWSER_BLOCKED_CHALLENGE"
  | "RESEARCH_FETCH_BROWSER_LOGIN_REQUIRED"
  | "RESEARCH_FETCH_BROWSER_FAILED"
  | "RESEARCH_FETCH_VISION_NOT_CONFIGURED"
  | "RESEARCH_FETCH_VISION_FAILED"
  | "RESEARCH_INTERNAL";

const RETRYABLE_CODES: ReadonlySet<string> = new Set([
  "RESEARCH_SEARCH_RATE_LIMITED",
  "RESEARCH_SEARCH_NETWORK_FAILED",
  "RESEARCH_SEARCH_TIMEOUT",
  "RESEARCH_FETCH_NETWORK_FAILED",
  "RESEARCH_FETCH_TIMEOUT",
  "RESEARCH_FETCH_HTTP_RATE_LIMITED",
  "RESEARCH_FETCH_HTTP_UPSTREAM_ERROR",
]);

export class ResearchError extends Error {
  readonly code: ResearchErrorCode;
  readonly retryable: boolean;

  constructor(code: ResearchErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ResearchError";
    this.code = code;
    this.retryable = RETRYABLE_CODES.has(code);
  }
}
