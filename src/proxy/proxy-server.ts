import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as https from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadConfiguredRulePacks } from '../core/rule-packs.js';
import { scrub } from '../core/scrub.js';
import type { ScrubOptions } from '../types/index.js';
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

export async function createProxyServer(
  options: ProxyOptions,
  listener?: ProxyEventListener,
): Promise<ProxyHandle> {
  const log = options.log ?? console.error;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const sessions = options.sessionStore ?? new Map<string, Record<string, string>>();

  // Load rule pack detectors once at startup so each request stays sync.
  const { detectors: rulePackDetectors } = await loadConfiguredRulePacks();
  const baseScrubOptions = buildBaseScrubOptions(options.scrubOptions, rulePackDetectors);

  const emit = (event: ProxyEvent) => {
    if (options.verbose) {
      log(`[proxy] ${JSON.stringify(event)}`);
    }
    listener?.(event);
  };

  const server = http.createServer((req, res) => {
    handleClientRequest(
      req,
      res,
      options,
      sessions,
      baseScrubOptions,
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
    });
  });

  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.removeListener('error', onError);
      reject(err);
    };
    server.once('error', onError);

    const host = options.host ?? '127.0.0.1';
    server.listen(options.port, host, () => {
      server.removeListener('error', onError);
      const address = server.address();
      const boundPort = typeof address === 'object' && address ? address.port : options.port;
      const url = `http://${host}:${boundPort}`;
      const handle: ProxyHandle = {
        url,
        port: boundPort,
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            server.close((err) => (err ? closeReject(err) : closeResolve()));
          }),
      };
      log(`[proxy] Listening on ${url} → ${options.target.href}`);
      resolve(handle);
    });
  });
}

/**
 * Translate the CLI-shaped `ScrubCliOptions` (comma-separated strings, etc.)
 * into the structured `ScrubOptions` accepted by `scrub()`. Merged with the
 * pre-loaded rule-pack detectors.
 */
function buildBaseScrubOptions(
  raw: ProxyOptions['scrubOptions'],
  rulePackDetectors: import('../types/index.js').Detector[],
): ScrubOptions {
  const scrub: ScrubOptions = { customDetectors: rulePackDetectors };
  if (!raw) return scrub;

  const disabled = parseList(raw.disable);
  const enabled = parseList(raw.enable);
  if (disabled.length > 0) scrub.disabledDetectors = disabled;
  if (enabled.length > 0) scrub.enabledDetectors = enabled;
  if (raw.strictName !== undefined) scrub.strictNameDetector = raw.strictName;
  if (raw.codeTellTerms !== undefined) {
    const terms = parseList(raw.codeTellTerms);
    if (terms.length > 0) scrub.codeTellTerms = terms;
  }
  if (raw.urlAllowlist !== undefined) {
    const list = parseList(raw.urlAllowlist);
    if (list.length > 0) scrub.urlAllowlist = list;
  }
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

async function handleClientRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: ProxyOptions,
  sessions: Map<string, Record<string, string>>,
  baseScrubOptions: ScrubOptions,
  emit: (event: ProxyEvent) => void,
  log: (msg: string) => void,
  maxBodyBytes: number,
): Promise<void> {
  const inboundSession = readSessionHeader(req.headers[SESSION_HEADER]);
  const sessionId = inboundSession ?? crypto.randomUUID();
  if (!sessions.has(sessionId)) sessions.set(sessionId, {});

  const incomingUrl = req.url ?? '/';
  const provider = detectProvider(parsePath(incomingUrl));

  emit({
    type: 'request',
    method: req.method ?? 'GET',
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
      return;
    }
  }

  // Build the upstream request body. For known providers we scrub the JSON;
  // everything else is forwarded as-is.
  let upstreamBody: Buffer | undefined = bodyBuf;
  if (provider !== 'unknown' && bodyBuf && bodyBuf.length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyBuf.toString('utf8'));
    } catch {
      emit({ type: 'passthrough', reason: 'non-json body' });
    }
    if (parsed !== undefined) {
      const map = sessions.get(sessionId) ?? {};
      // The scrubber's reverse-lookup (`valueToPlaceholder`) keeps stable
      // placeholders for values it has seen before, so round-trips from the
      // client (which sends placeholders) and fresh PII both end up
      // referencing the same map without an explicit rehydrate step.
      const outcome = scrubChatBody(provider, parsed, (text) =>
        scrubTextSync(text, sessionId, map, baseScrubOptions),
      );
      upstreamBody = Buffer.from(JSON.stringify(outcome.body), 'utf8');
      if (outcome.entities > 0) {
        emit({ type: 'scrubbed', sessionId, entities: outcome.entities });
      }
    }
  } else if (provider === 'unknown') {
    emit({ type: 'passthrough', reason: 'unknown provider' });
  }

  const upstreamHeaders = buildUpstreamHeaders(req.headers, options.target);
  upstreamHeaders[SESSION_HEADER] = sessionId;

  const upstreamResponse = await dispatchUpstream(options.target, {
    method: req.method ?? 'GET',
    path: incomingUrl,
    headers: upstreamHeaders,
    ...(upstreamBody !== undefined ? { body: upstreamBody } : {}),
  });

  const responseHeaders = filterResponseHeaders(upstreamResponse.headers);
  responseHeaders[SESSION_HEADER] = sessionId;

  const contentType = upstreamResponse.headers['content-type'] ?? '';
  const isStreaming = detectStreaming(contentType, bodyBuf);

  if (isStreaming) {
    res.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
    pipeStreamingResponse(
      upstreamResponse,
      res,
      provider,
      sessions.get(sessionId) ?? {},
      sessionId,
      emit,
      log,
    );
  } else {
    const chunks: Buffer[] = [];
    for await (const chunk of upstreamResponse.body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    let payload = Buffer.concat(chunks);
    const map = sessions.get(sessionId) ?? {};
    if (payload.length > 0 && contentType.toLowerCase().includes('application/json')) {
      try {
        const parsed = JSON.parse(payload.toString('utf8'));
        const { body, placeholders } = rehydrateJsonBody(provider, parsed, map);
        payload = Buffer.from(JSON.stringify(body), 'utf8');
        if (placeholders > 0) {
          emit({ type: 'rehydrated', sessionId, placeholders });
        }
      } catch {
        // Not JSON despite the header — forward unchanged.
      }
    }
    res.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
    res.end(payload);
  }
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
): { content: string; entities: number } {
  const result = scrub({
    content: text,
    sessionId,
    sessionMap,
    options: baseOptions,
  });
  const scrubbed = typeof result.scrubbedContent === 'string' ? result.scrubbedContent : text;
  return { content: scrubbed, entities: result.stats.totalEntities };
}

function detectStreaming(contentType: string, requestBody: Buffer | undefined): boolean {
  if (contentType.toLowerCase().includes('text/event-stream')) return true;
  if (!requestBody) return false;
  // Match `"stream":true` and `"stream": true` and friends without parsing
  // the whole body. False positives are harmless — we just stream a buffer.
  return /"stream"\s*:\s*true/.test(requestBody.toString('utf8'));
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
        rejectOnce(new Error(`request body exceeded ${maxBodyBytes} bytes`));
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

function readSessionHeader(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (Array.isArray(value) && typeof value[0] === 'string' && value[0].length > 0) {
    return value[0];
  }
  return undefined;
}

function buildUpstreamHeaders(
  incoming: http.IncomingHttpHeaders,
  target: URL,
): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
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
      },
      (res) => {
        resolve({
          statusCode: res.statusCode ?? 502,
          headers: res.headers,
          body: res,
        });
      },
    );
    upstreamReq.on('error', reject);
    if (req.body && req.body.length > 0) {
      upstreamReq.write(req.body);
    }
    upstreamReq.end();
  });
}

function pipeStreamingResponse(
  upstream: { body: AsyncIterable<Buffer> },
  downstream: ServerResponse,
  provider: ProxyProvider,
  sessionMap: Record<string, string>,
  sessionId: string,
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
      if (totalRehydrated > 0) {
        emit({ type: 'rehydrated', sessionId, placeholders: totalRehydrated });
      }
    } catch (err) {
      log(`[proxy] error flushing tail: ${(err as Error).message}`);
    }
  };

  const stream = upstream.body as unknown as NodeJS.ReadableStream;

  const onError = (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    emit({ type: 'error', message });
    log(`[proxy] upstream stream error: ${message}`);
    if (!downstream.headersSent) {
      downstream.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    }
    try {
      downstream.end(`prompt-scrub proxy: upstream stream error: ${message}\n`);
    } catch {
      // Already torn down.
    }
    closed = true;
  };

  const onData = (chunk: Buffer | Uint8Array) => {
    try {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const before = countPlaceholders(buf.toString('utf8'));
      const out = rehydrator.push(buf);
      const after = countPlaceholders(out);
      totalRehydrated += Math.max(0, before - after);
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
    try {
      stream.removeListener('data', onData as (c: unknown) => void);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
      const maybeDestroy = (stream as unknown as { destroy?: () => void }).destroy;
      if (typeof maybeDestroy === 'function') maybeDestroy.call(stream);
    } catch {
      // ignore
    }
  });
}

/**
 * Cheap heuristic to count `«Foo_N»` fragments in a string. Used to compute
 * how many placeholders were rewritten in a streaming chunk — the actual
 * rehydrator does the real work and would otherwise require walking the
 * tokenised stream.
 */
function countPlaceholders(text: string): number {
  let count = 0;
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf('«', i);
    if (start === -1) return count;
    const end = text.indexOf('»', start + 1);
    if (end === -1) return count;
    count += 1;
    i = end + 1;
  }
  return count;
}
