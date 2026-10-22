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
  /**
   * How many sessions to keep before the least recently used is forgotten.
   * Defaults to 1000. A session that holds no placeholders is not kept at all.
   */
  maxSessions?: number;
  /**
   * Require this token in the `x-prompt-scrub-token` header of every request
   * except `/healthz`; others get `401`. The header is never forwarded upstream.
   * Without it the proxy is open to anyone who can reach its port, which only
   * matters when `host` is not a loopback address.
   */
  authToken?: string;
  /**
   * Fail closed: refuse with `403` any request that carries a body the proxy
   * cannot scrub (an unrecognised endpoint, a compressed body, or a body that
   * is not JSON) instead of forwarding it untouched. Defaults to `false`.
   */
  strict?: boolean;
  /**
   * Re-read `config.json` on SIGHUP and when it changes on disk. Defaults to
   * `false` for the library; the CLI enables it unless `--no-reload-config` is passed.
   */
  reloadConfig?: boolean;
  /**
   * Append one JSON line per completed request to this file. Records hold
   * counts, categories and timings only: never values, bodies, headers or
   * query strings.
   */
  auditLog?: string;
  /**
   * Serve `GET /healthz` and `GET /metrics` on the proxy's port instead of
   * forwarding those paths upstream. Defaults to true.
   */
  metrics?: boolean;
  /** Proxy version reported by `/healthz` and `/metrics`. Defaults to `unknown`. */
  version?: string;
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
  | { type: 'blocked'; reason: string }
  | { type: 'error'; message: string }
  | {
      type: 'config_reloaded';
      trigger: 'signal' | 'watch';
      rulePacks: number;
      detectors: number;
      urlAllowlist: number;
    }
  | { type: 'config_reload_failed'; trigger: 'signal' | 'watch'; reason: string }
  /**
   * Emitted exactly once per client request, after the response has been
   * sent (or the connection has gone). `path` has no query string.
   */
  | {
      type: 'response';
      requestId: string;
      sessionId: string;
      method: string;
      path: string;
      provider: ProxyProvider;
      status: number;
      durationMs: number;
      streaming: boolean;
      outcome: 'ok' | 'passthrough' | 'rejected' | 'error';
      entities: number;
      byCategory: Record<string, number>;
      /** Findings a `minConfidence` threshold discarded, so they were forwarded unredacted. */
      suppressed: number;
      suppressedByCategory: Record<string, number>;
      rehydrated: number;
      errorKind?:
        | 'body_too_large'
        | 'upstream_timeout'
        | 'upstream_error'
        | 'client_aborted'
        | 'strict_blocked'
        | 'unauthorized'
        | 'internal';
    };

export type ProxyEventListener = (event: ProxyEvent) => void;
