import * as crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as http from 'node:http';
import * as https from 'node:https';
import { warnIfLocaleUnused } from '../cli/locale.js';
import {
  getConfigDir,
  loadConfig,
  type PromptScrubConfig,
  readConfigFile,
} from '../core/config.js';
import { addCount } from '../core/counts.js';
import { loadConfiguredRulePacks } from '../core/rule-packs.js';
import { scrub } from '../core/scrub.js';
import { placeholderTokensIn } from '../session/session-manager.js';
import type { ScrubOptions } from '../types/index.js';
import { AuditLog } from './audit-log.js';
import { type ConfigReloader, createConfigReloader } from './config-reloader.js';
import { ProxyMetrics } from './metrics.js';
import { detectProvider, scrubChatBody } from './request-transform.js';
import { createSseRehydrator, rehydrateJsonBody } from './response-transform.js';
import type {
  ProxyEvent,
  ProxyEventListener,
  ProxyHandle,
  ProxyOptions,
  ProxyProvider,
} from './types.js';

/** Hop-by-hop headers (RFC 7230 §6.1). These must not be forwarded. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'host',
]);

/** Header used to thread the session ID through requests and responses. */
export const SESSION_HEADER = 'x-prompt-scrub-session';

const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 30_000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

type ErrorKind = NonNullable<Extract<ProxyEvent, { type: 'response' }>['errorKind']>;

type Sessions = Map<string, Record<string, string>>;

/** Failure talking to the upstream provider. `kind` feeds metrics and the audit log. */
class UpstreamFailure extends Error {
  readonly kind: 'upstream_timeout' | 'upstream_error';

  constructor(message: string, kind: 'upstream_timeout' | 'upstream_error') {
    super(message);
    this.name = 'UpstreamFailure';
    this.kind = kind;
  }
}

/** Client body exceeded `maxBodyBytes`. */
class BodyTooLargeError extends Error {
  constructor(maxBodyBytes: number) {
    super(`request body exceeded ${maxBodyBytes} bytes`);
    this.name = 'BodyTooLargeError';
  }
}

/**
 * Per-request bookkeeping. Created once per client request and finished
 * exactly once, which emits the `response` event.
 */
interface RequestTrace {
  requestId: string;
  sessionId: string;
  method: string;
  /** Raw request target, including any query string. Only forwarded, never recorded. */
  url: string;
  /** Request path without the query string. Safe to record. */
  path: string;
  provider: ProxyProvider;
  start: number;
  streaming: boolean;
  entities: number;
  byCategory: Record<string, number>;
  suppressed: number;
  suppressedByCategory: Record<string, number>;
  rehydrated: number;
  passthroughReason: string | undefined;
  finished: boolean;
}

export async function createProxyServer(
  options: ProxyOptions,
  listener?: ProxyEventListener,
): Promise<ProxyHandle> {
  const log = options.log ?? console.error;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const sessions: Sessions = options.sessionStore ?? new Map<string, Record<string, string>>();
  const serveObservability = options.metrics !== false;
  const version = options.version ?? 'unknown';

  // Load rule pack detectors once at startup so each request stays sync. The
  // holder is read once per request, so a reload never changes options midway
  // through a request.
  const { detectors: rulePackDetectors } = await loadConfiguredRulePacks();
  const startConfig = loadConfig();
  const scrubState = {
    current: buildBaseScrubOptions(options.scrubOptions, rulePackDetectors, startConfig),
  };
  warnIfLocaleUnused(startConfig.locale ?? '', rulePackDetectors, log);
  const logThreshold = () => {
    const threshold = scrubState.current.minConfidence;
    if (threshold) {
      log(
        `[proxy] minConfidence ${threshold}: findings scored below it are not redacted. They are counted in prompt_scrub_suppressed_total.`,
      );
    }
  };

  // Opened before listening so an unwritable --audit-log fails startup.
  const metrics = new ProxyMetrics(version);
  const audit =
    options.auditLog === undefined
      ? undefined
      : AuditLog.open(options.auditLog, {
          log,
          onDrop: () => metrics.recordAuditDropped(),
        });

  const emit = (event: ProxyEvent) => {
    if (options.verbose) {
      log(`[proxy] ${JSON.stringify(event)}`);
    }
    metrics.observe(event);
    if (event.type === 'response') {
      audit?.write({ ts: new Date().toISOString(), ...event });
    }
    listener?.(event);
  };

  let reloader: ConfigReloader | undefined;
  // Applies the config file as it is on disk now. Throwing keeps the previous config.
  const applyConfig = async () => {
    const file = readConfigFile();
    if (!file.exists) {
      throw new Error('config file is missing; keeping the previous configuration');
    }
    if (file.errors.length > 0) {
      throw new Error(
        `config is invalid; keeping the previous configuration. ${file.errors.join(' ')}`,
      );
    }
    const { detectors, metadata } = await loadConfiguredRulePacks();
    const loaded = new Set(metadata.map((m) => m.source));
    const failed = (file.config.rulePacks ?? []).filter(
      (name) => !loaded.has(`rule-pack: ${name}`),
    );
    if (failed.length > 0) {
      throw new Error(
        `rule pack(s) failed to load, keeping the previous configuration: ${failed.join(', ')}`,
      );
    }
    scrubState.current = buildBaseScrubOptions(options.scrubOptions, detectors, file.config);
    warnIfLocaleUnused(file.config.locale ?? '', detectors, log);
    logThreshold();
    return {
      rulePacks: file.config.rulePacks?.length ?? 0,
      detectors: detectors.length,
      urlAllowlist: scrubState.current.urlAllowlist?.length ?? 0,
    };
  };

  const server = http.createServer((req, res) => {
    const route = serveObservability ? observabilityRoute(req) : undefined;
    if (route) {
      respondObservability(req, res, route, metrics, version);
      return;
    }

    const trace = createTrace(req, sessions);
    handleClientRequest(
      req,
      res,
      trace,
      options,
      sessions,
      scrubState,
      emit,
      log,
      maxBodyBytes,
    ).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      emit({ type: 'error', message });
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      }
      try {
        res.end(`prompt-scrub proxy error: ${message}\n`);
      } catch {
        // Connection may already be torn down by the upstream error.
      }
      const kind = err instanceof UpstreamFailure ? err.kind : 'internal';
      finishTrace(trace, emit, res.statusCode, kind);
    });
  });

  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.removeListener('error', onError);
      void audit?.close();
      reject(err);
    };
    server.once('error', onError);

    const host = options.host ?? '127.0.0.1';
    server.listen(options.port, host, () => {
      server.removeListener('error', onError);
      const address = server.address();
      const boundPort = typeof address === 'object' && address ? address.port : options.port;
      const url = `http://${host}:${boundPort}`;

      if (options.reloadConfig) {
        reloader = createConfigReloader({
          dir: getConfigDir(),
          apply: applyConfig,
          emit,
          log,
        });
      }

      let closing: Promise<void> | undefined;
      const handle: ProxyHandle = {
        url,
        port: boundPort,
        close: () => {
          reloader?.close();
          closing ??= new Promise<void>((closeResolve, closeReject) => {
            server.close((err) => (err ? closeReject(err) : closeResolve()));
          }).finally(() => audit?.close());
          return closing;
        },
      };

      log(`[proxy] Listening on ${url} → ${options.target.href}`);
      if (options.auditLog !== undefined) {
        log(`[proxy] Audit log: ${options.auditLog}`);
      }
      logThreshold();
      if (options.strict) {
        log('[proxy] Strict mode: requests with a body that cannot be scrubbed are blocked.');
      }
      if (serveObservability) {
        log(`[proxy] Metrics: ${url}/metrics  Health: ${url}/healthz`);
        if (!LOOPBACK_HOSTS.has(host)) {
          log(
            `[proxy] Warning: ${host} is not a loopback address. /metrics and /healthz are unauthenticated.`,
          );
        }
      }
      if (reloader) {
        const how = [
          reloader.signal ? 'SIGHUP' : null,
          reloader.watching ? 'file changes' : null,
        ].filter(Boolean);
        log(`[proxy] Config reload enabled (${how.join(' or ') || 'no trigger available'}).`);
      }
      resolve(handle);
    });
  });
}

/**
 * Translate the CLI-shaped `ScrubCliOptions` (comma-separated strings, etc.)
 * into the structured `ScrubOptions` accepted by `scrub()`. Merged with the
 * pre-loaded rule-pack detectors and the config file's allowlist, confidence
 * threshold and locale, so the proxy behaves like the standalone `scrub` command.
 */
function buildBaseScrubOptions(
  raw: ProxyOptions['scrubOptions'],
  rulePackDetectors: import('../types/index.js').Detector[],
  config: Pick<PromptScrubConfig, 'urlAllowlist' | 'minConfidence' | 'locale'> = {},
): ScrubOptions {
  const scrub: ScrubOptions = { customDetectors: rulePackDetectors };
  const disabled = parseList(raw?.disable);
  const enabled = parseList(raw?.enable);
  if (disabled.length > 0) scrub.disabledDetectors = disabled;
  if (enabled.length > 0) scrub.enabledDetectors = enabled;
  if (raw?.strictName !== undefined) scrub.strictNameDetector = raw.strictName;
  const codeTellTerms = parseList(raw?.codeTellTerms);
  if (codeTellTerms.length > 0) scrub.codeTellTerms = codeTellTerms;
  const urlAllowlist = Array.from(
    new Set([...(config.urlAllowlist ?? []), ...parseList(raw?.urlAllowlist)]),
  );
  if (urlAllowlist.length > 0) scrub.urlAllowlist = urlAllowlist;
  if (config.minConfidence) scrub.minConfidence = config.minConfidence;
  if (config.locale) scrub.locale = config.locale;
  return scrub;
}

function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Convenience wrapper: create the server, log readiness, and block until the
 * caller sends SIGINT/SIGTERM.
 */
export async function runProxy(options: ProxyOptions): Promise<void> {
  const handle = await createProxyServer(options);
  const log = options.log ?? console.error;

  await new Promise<void>((resolve) => {
    const stop = () => {
      log('[proxy] Shutting down.');
      handle.close().finally(() => resolve());
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

function createTrace(req: IncomingMessage, sessions: Sessions): RequestTrace {
  const inboundSession = readSessionHeader(req.headers[SESSION_HEADER]);
  // Only accept client-supplied session IDs that match a UUID — the proxy
  // generates a fresh one when the client omits the header. This caps the
  // growth vector (a malicious caller can no longer feed arbitrary strings
  // into the in-memory session map) without breaking the documented
  // "share a session ID across requests" workflow.
  const sessionId = inboundSession && isUuid(inboundSession) ? inboundSession : crypto.randomUUID();
  if (!sessions.has(sessionId)) sessions.set(sessionId, {});

  const url = req.url ?? '/';
  const path = parsePath(url);
  return {
    requestId: crypto.randomUUID(),
    sessionId,
    method: req.method ?? 'GET',
    url,
    path,
    provider: detectProvider(path),
    start: performance.now(),
    streaming: false,
    entities: 0,
    byCategory: {},
    suppressed: 0,
    suppressedByCategory: {},
    rehydrated: 0,
    passthroughReason: undefined,
    finished: false,
  };
}

/**
 * Emit the `response` event for a request. Safe to call from several
 * completion paths; only the first call has any effect.
 */
function finishTrace(
  trace: RequestTrace,
  emit: (event: ProxyEvent) => void,
  status: number,
  errorKind?: ErrorKind,
): void {
  if (trace.finished) return;
  trace.finished = true;

  const outcome = errorKind
    ? errorKind === 'body_too_large' || errorKind === 'strict_blocked'
      ? 'rejected'
      : 'error'
    : trace.passthroughReason !== undefined
      ? 'passthrough'
      : 'ok';

  emit({
    type: 'response',
    requestId: trace.requestId,
    sessionId: trace.sessionId,
    method: trace.method,
    path: trace.path,
    provider: trace.provider,
    status,
    durationMs: Number((performance.now() - trace.start).toFixed(3)),
    streaming: trace.streaming,
    outcome,
    entities: trace.entities,
    byCategory: trace.byCategory,
    suppressed: trace.suppressed,
    suppressedByCategory: trace.suppressedByCategory,
    rehydrated: trace.rehydrated,
    ...(errorKind ? { errorKind } : {}),
  });
}

async function handleClientRequest(
  req: IncomingMessage,
  res: ServerResponse,
  trace: RequestTrace,
  options: ProxyOptions,
  sessions: Sessions,
  scrubState: { current: ScrubOptions },
  emit: (event: ProxyEvent) => void,
  log: (msg: string) => void,
  maxBodyBytes: number,
): Promise<void> {
  const { sessionId, provider, url: incomingUrl } = trace;
  const baseScrubOptions = scrubState.current;

  emit({
    type: 'request',
    method: trace.method,
    path: incomingUrl,
    provider,
    sessionId,
  });

  let bodyBuf: Buffer | undefined;
  if (hasMeaningfulBody(req)) {
    try {
      bodyBuf = await readBody(req, maxBodyBytes);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`prompt-scrub proxy: request body too large or unreadable: ${message}\n`);
      emit({ type: 'error', message: `request body: ${message}` });
      finishTrace(
        trace,
        emit,
        413,
        err instanceof BodyTooLargeError ? 'body_too_large' : 'client_aborted',
      );
      // Tear the client socket down rather than letting it finish uploading
      // a body we'll only discard — surfaces as ECONNRESET to the caller
      // instead of a silent hang on a half-closed connection.
      try {
        req.destroy();
      } catch {
        // Already torn down.
      }
      return;
    }
  }

  // Build the upstream request body. For known providers we scrub the JSON;
  // everything else is forwarded as-is, unless `strict` is on and there is a
  // body we would be sending out unscrubbed.
  let upstreamBody: Buffer | undefined = bodyBuf;
  let parsed: unknown;
  let unscrubbedReason: string | undefined;
  if (provider === 'unknown') {
    unscrubbedReason = 'unknown provider';
  } else if (bodyBuf !== undefined && bodyBuf.length > 0) {
    if (isContentEncoded(req.headers['content-encoding'])) {
      unscrubbedReason = 'compressed body';
    } else {
      try {
        parsed = JSON.parse(bodyBuf.toString('utf8'));
      } catch {
        unscrubbedReason = 'non-json body';
      }
    }
  }

  if (unscrubbedReason !== undefined) {
    if (options.strict && bodyBuf !== undefined && bodyBuf.length > 0) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(
        `prompt-scrub proxy: request blocked in strict mode (${unscrubbedReason}). It was not forwarded upstream.\n`,
      );
      emit({ type: 'blocked', reason: unscrubbedReason });
      finishTrace(trace, emit, 403, 'strict_blocked');
      return;
    }
    trace.passthroughReason = unscrubbedReason;
    emit({ type: 'passthrough', reason: unscrubbedReason });
  } else if (parsed !== undefined) {
    const map = sessions.get(sessionId) ?? {};
    reserveLiteralPlaceholders(provider, parsed, map);
    // The scrubber's reverse-lookup (`valueToPlaceholder`) keeps stable
    // placeholders for values it has seen before, so round-trips from the
    // client (which sends placeholders) and fresh PII both end up
    // referencing the same map without an explicit rehydrate step.
    const outcome = scrubChatBody(provider, parsed, (text) => {
      const scrubbed = scrubTextSync(text, sessionId, map, baseScrubOptions);
      mergeCounts(trace.byCategory, scrubbed.byCategory);
      mergeCounts(trace.suppressedByCategory, scrubbed.suppressedByCategory);
      trace.suppressed += scrubbed.suppressed;
      return scrubbed;
    });
    trace.entities = outcome.entities;
    upstreamBody = Buffer.from(JSON.stringify(outcome.body), 'utf8');
    if (outcome.entities > 0) {
      emit({ type: 'scrubbed', sessionId, entities: outcome.entities });
    }
  }

  const upstreamHeaders = buildUpstreamHeaders(req.headers, options.target);

  const upstreamResponse = await dispatchUpstream(options.target, {
    method: trace.method,
    path: joinTargetPath(options.target, incomingUrl),
    headers: upstreamHeaders,
    ...(upstreamBody !== undefined ? { body: upstreamBody } : {}),
  });

  const responseHeaders = filterResponseHeaders(upstreamResponse.headers);
  responseHeaders[SESSION_HEADER] = sessionId;

  const status = upstreamResponse.statusCode ?? 502;
  const contentType = upstreamResponse.headers['content-type'] ?? '';
  const isStreaming = contentType.toLowerCase().includes('text/event-stream');
  trace.streaming = isStreaming;

  if (isStreaming) {
    res.writeHead(status, responseHeaders);
    pipeStreamingResponse(
      upstreamResponse,
      res,
      provider,
      sessions.get(sessionId) ?? {},
      trace,
      emit,
      log,
    );
    return;
  }

  const chunks: Buffer[] = [];
  try {
    for await (const chunk of upstreamResponse.body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
  } catch (err) {
    throw toUpstreamFailure(err);
  }
  let payload = Buffer.concat(chunks);
  const map = sessions.get(sessionId) ?? {};
  // Only attempt to rehydrate if this session actually has mappings. A
  // 4xx error body from the upstream carries no placeholders — running
  // it through the rehydrator is a no-op, but skipping the path entirely
  // is faster and avoids surprising the client with re-serialised
  // whitespace from upstream's compact JSON.
  const shouldRehydrate =
    payload.length > 0 &&
    contentType.toLowerCase().includes('application/json') &&
    Object.keys(map).length > 0;
  if (shouldRehydrate) {
    try {
      const parsed = JSON.parse(payload.toString('utf8'));
      const { body, placeholders } = rehydrateJsonBody(provider, parsed, map);
      payload = Buffer.from(JSON.stringify(body), 'utf8');
      trace.rehydrated = placeholders;
      if (placeholders > 0) {
        emit({ type: 'rehydrated', sessionId, placeholders });
      }
    } catch {
      // Not JSON despite the header — forward unchanged.
    }
  }
  res.writeHead(status, responseHeaders);
  res.end(payload);
  finishTrace(trace, emit, status);
}

/**
 * Run the scrubber synchronously over a single string and return the
 * rewritten text plus a replacement count. The session map is mutated in
 * place by `scrub()` (it shares the reference internally), so the proxy's
 * caller-side map reflects any new placeholders immediately.
 */
function scrubTextSync(
  text: string,
  sessionId: string,
  sessionMap: Record<string, string>,
  baseOptions: ScrubOptions,
): {
  content: string;
  entities: number;
  byCategory: Record<string, number>;
  suppressed: number;
  suppressedByCategory: Record<string, number>;
} {
  const result = scrub({
    content: text,
    sessionId,
    sessionMap,
    options: baseOptions,
  });
  const scrubbed = typeof result.scrubbedContent === 'string' ? result.scrubbedContent : text;
  return {
    content: scrubbed,
    entities: result.stats.totalEntities,
    byCategory: result.stats.byCategory,
    suppressed: result.stats.suppressed?.total ?? 0,
    suppressedByCategory: result.stats.suppressed?.byCategory ?? {},
  };
}

/**
 * Claim every placeholder the request already carries literally, across all of
 * its messages and for the rest of the session. `scrub()` runs once per string
 * with a fresh SessionManager, so without this a literal «Email_1» in one
 * message does not stop another message, or a later request, minting «Email_1»
 * for a real address. The identity entry makes the token unavailable and
 * rehydrates back to itself.
 */
function reserveLiteralPlaceholders(
  provider: ProxyProvider,
  body: unknown,
  map: Record<string, string>,
): void {
  scrubChatBody(provider, body, (text) => {
    for (const token of placeholderTokensIn(text)) {
      if (!Object.hasOwn(map, token)) map[token] = token;
    }
    return { content: text, entities: 0 };
  });
}

function mergeCounts(into: Record<string, number>, from: Record<string, number>): void {
  for (const [key, count] of Object.entries(from)) {
    addCount(into, key, count);
  }
}

function readBody(req: IncomingMessage, maxBodyBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let rejected = false;

    const rejectOnce = (err: Error) => {
      if (rejected) return;
      rejected = true;
      reject(err);
    };

    req.on('data', (chunk: Buffer) => {
      if (rejected) {
        // Drain but discard so the socket can close cleanly.
        return;
      }
      total += chunk.length;
      if (total > maxBodyBytes) {
        // Stop accumulating. We let the request finish streaming so we can
        // return a proper 413 instead of yanking the socket.
        rejectOnce(new BodyTooLargeError(maxBodyBytes));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (rejected) return; // error already raised; promise is settled
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => rejectOnce(err));
  });
}

/** True when a `Content-Encoding` header names anything other than `identity`. */
function isContentEncoded(header: string | string[] | undefined): boolean {
  const value = Array.isArray(header) ? header.join(',') : (header ?? '');
  return value
    .split(',')
    .map((coding) => coding.trim().toLowerCase())
    .some((coding) => coding !== '' && coding !== 'identity');
}

function hasMeaningfulBody(req: IncomingMessage): boolean {
  if (req.method === undefined) return false;
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'DELETE' || method === 'OPTIONS') {
    return false;
  }
  // For POST/PUT/PATCH we always attempt to read a body. Some clients use
  // chunked transfer encoding (no Content-Length), others use Content-Length,
  // and some send an empty body — all three cases work if we just try to read.
  // We only skip if the client *explicitly* sent Content-Length: 0.
  const len = req.headers['content-length'];
  if (typeof len === 'string' || typeof len === 'number') {
    return Number(len) > 0;
  }
  return true;
}

function parsePath(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

/** Returns the observability route for this request, if it targets one. */
function observabilityRoute(req: IncomingMessage): '/healthz' | '/metrics' | undefined {
  const path = parsePath(req.url ?? '/');
  return path === '/healthz' || path === '/metrics' ? path : undefined;
}

function respondObservability(
  req: IncomingMessage,
  res: ServerResponse,
  route: '/healthz' | '/metrics',
  metrics: ProxyMetrics,
  version: string,
): void {
  const method = req.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' });
    res.end('method not allowed\n');
    return;
  }

  if (route === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ status: 'ok', uptimeSeconds: metrics.uptimeSeconds(), version }));
    return;
  }

  const url = new URL(req.url ?? '/', 'http://localhost');
  const wantsJson =
    url.searchParams.get('format') === 'json' ||
    (req.headers.accept ?? '').includes('application/json');
  if (wantsJson) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(metrics.toJSON()));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
  res.end(metrics.renderPrometheus());
}

function readSessionHeader(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (Array.isArray(value) && typeof value[0] === 'string' && value[0].length > 0) {
    return value[0];
  }
  return undefined;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function buildUpstreamHeaders(
  incoming: http.IncomingHttpHeaders,
  target: URL,
): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    // The session ID is between the client and this proxy. A provider that
    // received it could link every request of a session, whoever sent them.
    if (HOP_BY_HOP.has(lower) || lower === SESSION_HEADER) continue;
    headers[key] = value;
  }
  headers.host = target.host;
  // Strip content-length so Node recomputes it from the bytes we actually
  // write. The scrubber may change the body size (e.g. «Email_1» replaces a
  // long address), so the inbound length is no longer accurate.
  delete headers['content-length'];
  // Hint to upstream that we want uncompressed bytes — easier to transform
  // and avoids needing an `accept-encoding` dance.
  delete headers['accept-encoding'];
  return headers;
}

function filterResponseHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    out[key] = value;
  }
  // Rehydration typically lengthens the body (placeholders expand into the
  // real values), so the upstream's content-length no longer matches what
  // we'll actually write. Letting Node recompute it from the bytes we send
  // avoids desyncing the HTTP parser on the keep-alive connection.
  delete out['content-length'];
  return out;
}

interface DispatchRequest {
  method: string;
  path: string;
  headers: http.OutgoingHttpHeaders;
  body?: Buffer;
}

interface UpstreamResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: AsyncIterable<Buffer>;
}

function toUpstreamFailure(err: unknown): UpstreamFailure {
  if (err instanceof UpstreamFailure) return err;
  return new UpstreamFailure(err instanceof Error ? err.message : String(err), 'upstream_error');
}

function dispatchUpstream(target: URL, req: DispatchRequest): Promise<UpstreamResponse> {
  const client = target.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const upstreamReq = client.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        method: req.method,
        path: req.path,
        headers: req.headers,
        timeout: UPSTREAM_TIMEOUT_MS,
      },
      (res) => {
        resolve({
          statusCode: res.statusCode ?? 502,
          headers: res.headers,
          body: res,
        });
      },
    );
    upstreamReq.on('error', (err) => reject(toUpstreamFailure(err)));
    upstreamReq.on('timeout', () => {
      upstreamReq.destroy(
        new UpstreamFailure(
          `upstream timeout after ${UPSTREAM_TIMEOUT_MS / 1000}s`,
          'upstream_timeout',
        ),
      );
    });
    if (req.body && req.body.length > 0) {
      upstreamReq.write(req.body);
    }
    upstreamReq.end();
  });
}

/**
 * Join the target's pathname prefix with the incoming URL's path. Without
 * this, `--target https://gateway.example.com/openai` silently drops the
 * `/openai` prefix and every request lands on `/`.
 */
function joinTargetPath(target: URL, incomingUrl: string): string {
  const incomingPath = parsePath(incomingUrl);
  const base = target.pathname.replace(/\/$/, '');
  if (incomingPath === '/' || incomingPath === '') {
    return `${base}/`;
  }
  return `${base}${incomingPath}`;
}

function pipeStreamingResponse(
  upstream: { body: AsyncIterable<Buffer> },
  downstream: ServerResponse,
  provider: ProxyProvider,
  sessionMap: Record<string, string>,
  trace: RequestTrace,
  emit: (event: ProxyEvent) => void,
  log: (msg: string) => void,
): void {
  const rehydrator = createSseRehydrator(provider, sessionMap);
  let totalRehydrated = 0;
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    try {
      const tail = rehydrator.flush();
      if (tail.length > 0) downstream.write(tail);
      downstream.end();
      trace.rehydrated = totalRehydrated;
      if (totalRehydrated > 0) {
        emit({ type: 'rehydrated', sessionId: trace.sessionId, placeholders: totalRehydrated });
      }
      finishTrace(trace, emit, downstream.statusCode);
    } catch (err) {
      log(`[proxy] error flushing tail: ${(err as Error).message}`);
      finishTrace(trace, emit, downstream.statusCode, 'internal');
    }
  };

  const stream = upstream.body as unknown as NodeJS.ReadableStream;

  const onError = (err: unknown) => {
    const failure = toUpstreamFailure(err);
    emit({ type: 'error', message: failure.message });
    log(`[proxy] upstream stream error: ${failure.message}`);
    if (!downstream.headersSent) {
      downstream.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    }
    try {
      downstream.end(`prompt-scrub proxy: upstream stream error: ${failure.message}\n`);
    } catch {
      // Already torn down.
    }
    closed = true;
    finishTrace(trace, emit, downstream.statusCode, failure.kind);
  };

  const onData = (chunk: Buffer | Uint8Array) => {
    try {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const out = rehydrator.push(buf);
      // The rehydrator already counts what it replaced; emit a per-chunk
      // counter via the `rehydrated` event when chunks are small enough that
      // we don't want to wait for the close. (`createSseRehydrator` tracks
      // this internally; here we just count "did anything change?" to keep
      // the events cheap.)
      if (out !== buf.toString('utf8')) totalRehydrated += 1;
      if (out.length > 0) downstream.write(out);
    } catch (err) {
      onError(err);
    }
  };

  const onEnd = () => {
    close();
  };

  stream.on('data', onData as (c: unknown) => void);
  stream.on('end', onEnd);
  stream.on('error', onError);

  downstream.on('close', () => {
    stream.removeListener('data', onData as (c: unknown) => void);
    stream.removeListener('end', onEnd);
    stream.removeListener('error', onError);
    const maybeDestroy = (stream as unknown as { destroy?: () => void }).destroy;
    if (typeof maybeDestroy === 'function') maybeDestroy.call(stream);
    // No-op when the stream already completed; otherwise the client went away first.
    finishTrace(trace, emit, downstream.statusCode, 'client_aborted');
  });
}
