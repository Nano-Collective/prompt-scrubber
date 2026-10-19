import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'ava';
import { createProxyServer } from '../../src/proxy/proxy-server.js';
import type { ProxyEvent, ProxyHandle, ProxyOptions } from '../../src/proxy/types.js';
import { runProxyCommand } from '../../src/cli/commands/proxy.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const tmpConfigDir = path.join(__dirname, '.tmp-observability-config');
const tmpAuditDir = path.join(__dirname, '.tmp-observability-audit');

interface FakeUpstream {
  url: string;
  close: () => Promise<void>;
  requestCount: () => number;
}

function startFakeUpstream(
  handler: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void,
): Promise<FakeUpstream> {
  return new Promise((resolve) => {
    let count = 0;
    const server = http.createServer((req, res) => {
      count += 1;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => handler(req, Buffer.concat(chunks).toString('utf8'), res));
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
        requestCount: () => count,
      });
    });
  });
}

function jsonResponse(res: http.ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function makeRequest(url: string, init: http.RequestOptions & { body?: string }) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>(
    (resolve, reject) => {
      const parsed = new URL(url);
      const req = http.request(
        {
          hostname: parsed.hostname,
          port: parsed.port,
          path: parsed.pathname + parsed.search,
          method: init.method ?? 'POST',
          headers: init.headers ?? {},
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          );
        },
      );
      req.on('error', reject);
      if (init.body) req.write(init.body);
      req.end();
    },
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withProxy(
  upstream: FakeUpstream,
  options: Partial<ProxyOptions> = {},
  events: ProxyEvent[] = [],
): Promise<ProxyHandle> {
  return createProxyServer(
    {
      target: new URL(upstream.url),
      port: 0,
      host: '127.0.0.1',
      ...options,
    },
    (e) => {
      events.push(e);
    },
  );
}

test.before(() => {
  process.env.PROMPT_SCRUB_CONFIG_DIR = tmpConfigDir;
});

test.after.always(async () => {
  for (const dir of [tmpConfigDir, tmpAuditDir]) {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

const chatBody = JSON.stringify({
  model: 'gpt-test',
  messages: [{ role: 'user', content: 'Email alice@example.com about it' }],
});

test('/healthz answers locally without touching upstream or emitting request events', async (t) => {
  const upstream = await startFakeUpstream((_, __, res) => jsonResponse(res, 200, {}));
  const events: ProxyEvent[] = [];
  const proxy = await withProxy(upstream, {}, events);
  try {
    const res = await makeRequest(`${proxy.url}/healthz`, { method: 'GET' });
    t.is(res.status, 200);
    const body = JSON.parse(res.body) as { status: string; uptimeSeconds: number };
    t.is(body.status, 'ok');
    t.is(typeof body.uptimeSeconds, 'number');
    t.is(upstream.requestCount(), 0);
    t.deepEqual(events, []);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('/metrics reports redactions by category and never the values', async (t) => {
  const upstream = await startFakeUpstream((_, __, res) =>
    jsonResponse(res, 200, { choices: [{ message: { role: 'assistant', content: 'ok' } }] }),
  );
  const proxy = await withProxy(upstream);
  try {
    await makeRequest(`${proxy.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: chatBody,
    });
    const res = await makeRequest(`${proxy.url}/metrics`, { method: 'GET' });
    t.is(res.status, 200);
    t.regex(res.body, /prompt_scrub_requests_total\{provider="openai",status_class="2xx"\} 1/);
    t.regex(res.body, /prompt_scrub_entities_redacted_total\{category="Email"\} [1-9]/);
    t.false(res.body.includes('alice@example.com'));
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('/metrics serves JSON for ?format=json and for an Accept header', async (t) => {
  const upstream = await startFakeUpstream((_, __, res) => jsonResponse(res, 200, {}));
  const proxy = await withProxy(upstream);
  try {
    const byQuery = await makeRequest(`${proxy.url}/metrics?format=json`, { method: 'GET' });
    t.is(JSON.parse(byQuery.body).version, 'unknown');

    const byHeader = await makeRequest(`${proxy.url}/metrics`, {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
    t.true(byHeader.headers['content-type']?.includes('application/json'));
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('observability routes reject other methods with 405 and do not forward', async (t) => {
  const upstream = await startFakeUpstream((_, __, res) => jsonResponse(res, 200, {}));
  const proxy = await withProxy(upstream);
  try {
    const res = await makeRequest(`${proxy.url}/metrics`, { method: 'POST', body: 'x' });
    t.is(res.status, 405);
    t.is(res.headers.allow, 'GET, HEAD');
    t.is(upstream.requestCount(), 0);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('--no-metrics forwards /healthz upstream like any other path', async (t) => {
  const upstream = await startFakeUpstream((_, __, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('upstream-health');
  });
  const proxy = await withProxy(upstream, { metrics: false });
  try {
    const res = await makeRequest(`${proxy.url}/healthz`, { method: 'GET' });
    t.is(res.body, 'upstream-health');
    t.is(upstream.requestCount(), 1);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('audit log holds one line per request with no values, bodies or query strings', async (t) => {
  const upstream = await startFakeUpstream((req, _, res) => {
    if (req.url?.startsWith('/v1/models')) {
      jsonResponse(res, 200, { data: [] });
      return;
    }
    jsonResponse(res, 200, { choices: [{ message: { role: 'assistant', content: 'ok' } }] });
  });
  const auditFile = path.join(tmpAuditDir, 'audit.jsonl');
  const proxy = await withProxy(upstream, { auditLog: auditFile });
  try {
    await makeRequest(`${proxy.url}/v1/chat/completions?api_key=QUERY-SECRET-123`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: chatBody,
    });
    await makeRequest(`${proxy.url}/v1/models?token=TOKEN-456`, { method: 'GET' });
  } finally {
    await proxy.close();
    await upstream.close();
  }

  const raw = fs.readFileSync(auditFile, 'utf8');
  const records = raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

  t.is(records.length, 2);
  const [chat, models] = records as [Record<string, unknown>, Record<string, unknown>];
  t.is(chat?.outcome, 'ok');
  t.is(chat?.path, '/v1/chat/completions');
  t.is(chat?.status, 200);
  t.deepEqual(chat?.byCategory, { Email: 1 });
  t.is(models?.outcome, 'passthrough');
  t.is(models?.path, '/v1/models');

  // Privacy: nothing scrubbed, sent, or queried may leak into the audit file.
  t.false(raw.includes('alice@example.com'));
  t.false(raw.includes('QUERY-SECRET-123'));
  t.false(raw.includes('TOKEN-456'));
  t.false(raw.includes('api_key'));
  t.false(raw.includes('Email alice'));
});

test('a body over maxBodyBytes is recorded once as rejected', async (t) => {
  const upstream = await startFakeUpstream((_, __, res) => jsonResponse(res, 200, {}));
  const events: ProxyEvent[] = [];
  const proxy = await withProxy(upstream, { maxBodyBytes: 16 }, events);
  try {
    // The proxy tears the socket down on 413, so a client error here is expected.
    await makeRequest(`${proxy.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: chatBody,
    }).catch(() => undefined);
    await sleep(50);
    const responses = events.filter((e) => e.type === 'response');
    t.is(responses.length, 1);
    t.like(responses[0], { status: 413, outcome: 'rejected', errorKind: 'body_too_large' });
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('an unreachable upstream is recorded as upstream_error', async (t) => {
  const upstream = await startFakeUpstream((_, __, res) => jsonResponse(res, 200, {}));
  const url = upstream.url;
  await upstream.close();

  const events: ProxyEvent[] = [];
  const proxy = await withProxy({ ...upstream, url }, {}, events);
  try {
    const res = await makeRequest(`${proxy.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: chatBody,
    });
    t.is(res.status, 502);
    const response = events.find((e) => e.type === 'response');
    t.like(response, { status: 502, outcome: 'error', errorKind: 'upstream_error' });
  } finally {
    await proxy.close();
  }
});

test('a completed stream is recorded once with streaming set', async (t) => {
  const upstream = await startFakeUpstream((_, __, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
    res.end('data: [DONE]\n\n');
  });
  const events: ProxyEvent[] = [];
  const proxy = await withProxy(upstream, {}, events);
  try {
    await makeRequest(`${proxy.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: chatBody,
    });
  } finally {
    await proxy.close();
    await upstream.close();
  }
  const responses = events.filter((e) => e.type === 'response');
  t.is(responses.length, 1);
  t.like(responses[0], { status: 200, streaming: true, outcome: 'ok' });
});

test('a client that disconnects mid-stream is recorded as client_aborted', async (t) => {
  const upstream = await startFakeUpstream((_, __, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const timer = setInterval(() => res.write('data: {"choices":[]}\n\n'), 20);
    res.on('close', () => clearInterval(timer));
  });
  const events: ProxyEvent[] = [];
  const proxy = await withProxy(upstream, {}, events);
  try {
    await new Promise<void>((resolve) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: proxy.port,
          path: '/v1/chat/completions',
          method: 'POST',
          headers: { 'content-type': 'application/json' },
        },
        (res) => {
          res.once('data', () => {
            req.destroy();
            resolve();
          });
        },
      );
      req.on('error', () => undefined);
      req.end(chatBody);
    });

    for (let i = 0; i < 100 && !events.some((e) => e.type === 'response'); i += 1) {
      await sleep(20);
    }
    const responses = events.filter((e) => e.type === 'response');
    t.is(responses.length, 1);
    t.like(responses[0], { streaming: true, outcome: 'error', errorKind: 'client_aborted' });
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('--audit-log refuses a path that is a directory', async (t) => {
  fs.mkdirSync(tmpAuditDir, { recursive: true });
  const error = await t.throwsAsync(() =>
    runProxyCommand({
      target: 'http://127.0.0.1:9',
      port: '0',
      auditLog: tmpAuditDir,
      verbose: false,
      gc: false,
    }),
  );
  t.regex(error?.message ?? '', /path is a directory/);
});

test('--audit-log refuses an empty path', async (t) => {
  const error = await t.throwsAsync(() =>
    runProxyCommand({ target: 'http://127.0.0.1:9', port: '0', auditLog: '   ', gc: false }),
  );
  t.regex(error?.message ?? '', /must not be empty/);
});
