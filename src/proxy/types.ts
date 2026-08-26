// Shared types for the streaming / pipe-through proxy.

export type ProxyProvider = 'openai' | 'anthropic' | 'unknown';

export interface ScrubCliOptions {
  disable?: string;
  enable?: string;
  strictName?: boolean;
  codeTellTerms?: string;
  urlAllowlist?: string;
}

/**
 * Options accepted by `createProxyServer` / `runProxy`.
 *
 * The proxy is transport-agnostic: it forwards arbitrary HTTP verbs and most
 * headers. Bodies are only transformed when the request path matches a known
 * chat-completion shape and the body parses as JSON.
 */
export interface ProxyOptions {
  /** Upstream base URL, e.g. `https://api.openai.com`. Required. */
  target: URL;
  /** Local port to listen on. Required. */
  port: number;
  /** Local host to bind. Defaults to `127.0.0.1` (loopback only). */
  host?: string;
  /** Optional in-memory session store. When omitted, an in-process Map is created. */
  sessionStore?: Map<string, Record<string, string>>;
  /** Scrubber CLI options forwarded to `handleScrub`. */
  scrubOptions?: ScrubCliOptions;
  /**
   * If true, log every proxied request/response summary to `log` (default
   * `console.error`). Errors are always logged.
   */
  verbose?: boolean;
  /** Logger for non-error events. Defaults to `console.error`. */
  log?: (msg: string) => void;
  /** Maximum request body size in bytes. Defaults to 10 MB. */
  maxBodyBytes?: number;
}

/**
 * Handle returned by `createProxyServer`. Calling `close()` releases the port.
 */
export interface ProxyHandle {
  /** Local URL the proxy is listening on, e.g. `http://127.0.0.1:8080`. */
  url: string;
  /** Bound port. May differ from `options.port` when `port` was `0`. */
  port: number;
  /** Stop the server. Safe to call multiple times. */
  close: () => Promise<void>;
}

/**
 * Lightweight event stream useful for tests, metrics, and audit logging. The
 * proxy emits one event per request, regardless of whether the body was
 * transformed.
 */
export type ProxyEvent =
  | { type: 'request'; method: string; path: string; provider: ProxyProvider; sessionId: string }
  | { type: 'scrubbed'; sessionId: string; entities: number }
  | { type: 'rehydrated'; sessionId: string; placeholders: number }
  | { type: 'passthrough'; reason: string }
  | { type: 'error'; message: string };

export type ProxyEventListener = (event: ProxyEvent) => void;
