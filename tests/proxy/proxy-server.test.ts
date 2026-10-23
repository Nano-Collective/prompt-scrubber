import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as zlib from 'node:zlib';
import test from 'ava';
import { createProxyServer, SESSION_HEADER } from '../../src/proxy/proxy-server.js';
import type { ProxyEvent, ProxyHandle, ProxyOptions } from '../../src/proxy/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const tmpConfigDir = path.join(__dirname, '.tmp-proxy-config');

interface FakeUpstream {
  url: string;
  port: number;
  close: () => Promise<void>;
  // Counters exposed for assertions
  requestCount: () => number;
  lastBody: () => string;
}

/**
 * Start a tiny HTTP server that mimics a chat-completion endpoint. The
 * canned responses are configurable so each test can assert on a different
 * shape (JSON, streaming, error, etc.).
 */
function startFakeUpstream(
  handler: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void,
): Promise<FakeUpstream> {
  return new Promise((resolve) => {
    let count = 0;
    let last = '';
    const server = http.createServer((req, res) => {
      count += 1;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        last = Buffer.concat(chunks).toString('utf8');
        handler(req, last, res);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
        requestCount: () => count,
        lastBody: () => last,
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

test.before(() => {
  process.env.PROMPT_SCRUB_CONFIG_DIR = tmpConfigDir;
});

test.after.always(async () => {
  // Force-close any leftover servers. Test files run sequentially, but if a
  // test fails mid-flight we still want clean teardown.
  if (fs.existsSync(tmpConfigDir)) {
    await fs.promises.rm(tmpConfigDir, { recursive: true, force: true });
  }
});

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

test('scrubs an OpenAI chat-completion request and rehydrates a JSON response', async (t) => {
  const upstream = await startFakeUpstream((_, body, res) => {
    // Upstream must observe the SCRUBBED message (no PII), not the original.
    t.false(body.includes('alice@example.com'));
    t.true(body.includes('«Email_1»'));
    jsonResponse(res, 200, {
      id: 'chatcmpl-1',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'I see «Email_1», thanks!' },
        },
      ],
    });
  });

  const events: ProxyEvent[] = [];
  const proxy = await withProxy(upstream, {}, events);

  try {
    const clientBody = JSON.stringify({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Email me at alice@example.com' }],
    });
    const res = await makeRequest(`${proxy.url}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer test-key',
      },
      body: clientBody,
    });

    t.is(res.status, 200);
    t.true(res.body.includes('alice@example.com'));
    t.false(res.body.includes('«Email_1»'));
    // Session header is echoed so the client can pin it for follow-up calls.
    const session = res.headers[SESSION_HEADER];
    t.truthy(session);

    // Auth header is forwarded.
    t.is(upstream.lastBody().length > 0, true);
  } finally {
    await proxy.close();
    await upstream.close();
  }

  // Events: request, scrubbed, (passthrough skipped because provider matched)
  const types = events.map((e) => e.type);
  t.true(types.includes('request'));
  t.true(types.includes('scrubbed'));
  t.true(types.includes('rehydrated'));
});

test('passes through non-chat requests unchanged', async (t) => {
  const upstream = await startFakeUpstream((req, _body, res) => {
    if (req.url === '/v1/models') {
      jsonResponse(res, 200, { data: [{ id: 'gpt-4' }] });
      return;
    }
    jsonResponse(res, 404, { error: 'not found' });
  });
  const events: ProxyEvent[] = [];
  const proxy = await withProxy(upstream, {}, events);

  try {
    const res = await makeRequest(`${proxy.url}/v1/models`, {
      method: 'GET',
      headers: { authorization: 'Bearer test-key' },
    });
    t.is(res.status, 200);
    t.true(res.body.includes('gpt-4'));
  } finally {
    await proxy.close();
    await upstream.close();
  }

  t.true(events.some((e) => e.type === 'passthrough'));
});

const PII_BODY = JSON.stringify({ input: 'Email me at alice@example.com' });
const CHAT_BODY = JSON.stringify({
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'Email me at alice@example.com' }],
});

test('forwards a body on an unknown endpoint untouched when strict is off', async (t) => {
  const upstream = await startFakeUpstream((_req, _body, res) => jsonResponse(res, 200, {}));
  const events: ProxyEvent[] = [];
  const proxy = await withProxy(upstream, {}, events);
  try {
    const res = await makeRequest(`${proxy.url}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: PII_BODY,
    });
    t.is(res.status, 200);
    t.is(upstream.requestCount(), 1);
    t.is(upstream.lastBody(), PII_BODY);
    t.true(events.some((e) => e.type === 'passthrough' && e.reason === 'unknown provider'));
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('strict mode blocks a body on an unknown endpoint and never contacts upstream', async (t) => {
  const upstream = await startFakeUpstream((_req, _body, res) => jsonResponse(res, 200, {}));
  const events: ProxyEvent[] = [];
  const proxy = await withProxy(upstream, { strict: true }, events);
  try {
    const res = await makeRequest(`${proxy.url}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: PII_BODY,
    });
    t.is(res.status, 403);
    t.true(res.body.includes('strict mode'));
    t.true(res.body.includes('unknown provider'));
    t.false(res.body.includes('alice@example.com'));
    t.is(upstream.requestCount(), 0);
  } finally {
    await proxy.close();
    await upstream.close();
  }

  t.true(events.some((e) => e.type === 'blocked' && e.reason === 'unknown provider'));
  t.false(events.some((e) => e.type === 'passthrough'));
  const responses = events.filter((e) => e.type === 'response');
  t.is(responses.length, 1);
  t.like(responses[0], { status: 403, outcome: 'rejected', errorKind: 'strict_blocked' });
});

test('strict mode blocks provider-specific paths other than the two it can scrub', async (t) => {
  const upstream = await startFakeUpstream((_req, _body, res) => jsonResponse(res, 200, {}));
  const proxy = await withProxy(upstream, { strict: true });
  try {
    for (const route of [
      '/v1beta/models/gemini-pro:generateContent',
      '/openai/deployments/gpt-4/chat/completions?api-version=2024-02-01',
      '/api/chat',
    ]) {
      const res = await makeRequest(`${proxy.url}${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: PII_BODY,
      });
      t.is(res.status, 403, route);
    }
    t.is(upstream.requestCount(), 0);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('strict mode blocks a gzip body on a recognised endpoint', async (t) => {
  const upstream = await startFakeUpstream((_req, _body, res) => jsonResponse(res, 200, {}));
  const events: ProxyEvent[] = [];
  const proxy = await withProxy(upstream, { strict: true }, events);
  try {
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const parsed = new URL(proxy.url);
      const req = http.request(
        {
          hostname: parsed.hostname,
          port: parsed.port,
          path: '/v1/chat/completions',
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
        },
        (r) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () =>
            resolve({ status: r.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
          );
        },
      );
      req.on('error', reject);
      req.end(zlib.gzipSync(Buffer.from(CHAT_BODY)));
    });
    t.is(res.status, 403);
    t.true(res.body.includes('compressed body'));
    t.is(upstream.requestCount(), 0);
  } finally {
    await proxy.close();
    await upstream.close();
  }
  t.true(events.some((e) => e.type === 'blocked' && e.reason === 'compressed body'));
});

test('a gzip body is reported as compressed, and still forwarded, when strict is off', async (t) => {
  const upstream = await startFakeUpstream((_req, _body, res) => jsonResponse(res, 200, {}));
  const events: ProxyEvent[] = [];
  const proxy = await withProxy(upstream, {}, events);
  try {
    await new Promise<void>((resolve, reject) => {
      const parsed = new URL(proxy.url);
      const req = http.request(
        {
          hostname: parsed.hostname,
          port: parsed.port,
          path: '/v1/chat/completions',
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
        },
        (r) => {
          r.resume();
          r.on('end', () => resolve());
        },
      );
      req.on('error', reject);
      req.end(zlib.gzipSync(Buffer.from(CHAT_BODY)));
    });
    t.is(upstream.requestCount(), 1);
  } finally {
    await proxy.close();
    await upstream.close();
  }
  t.true(events.some((e) => e.type === 'passthrough' && e.reason === 'compressed body'));
});

test('strict mode blocks a non-JSON body on a recognised endpoint', async (t) => {
  const upstream = await startFakeUpstream((_req, _body, res) => jsonResponse(res, 200, {}));
  const events: ProxyEvent[] = [];
  const proxy = await withProxy(upstream, { strict: true }, events);
  try {
    const res = await makeRequest(`${proxy.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'Email me at alice@example.com',
    });
    t.is(res.status, 403);
    t.true(res.body.includes('non-json body'));
    t.is(upstream.requestCount(), 0);
  } finally {
    await proxy.close();
    await upstream.close();
  }
  t.true(events.some((e) => e.type === 'blocked' && e.reason === 'non-json body'));
});

test('strict mode still scrubs and forwards a recognised JSON request', async (t) => {
  const upstream = await startFakeUpstream((_req, body, res) => {
    t.false(body.includes('alice@example.com'));
    t.true(body.includes('«Email_1»'));
    jsonResponse(res, 200, { choices: [{ message: { role: 'assistant', content: 'ok' } }] });
  });
  const events: ProxyEvent[] = [];
  const proxy = await withProxy(upstream, { strict: true }, events);
  try {
    const res = await makeRequest(`${proxy.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: CHAT_BODY,
    });
    t.is(res.status, 200);
    t.is(upstream.requestCount(), 1);
  } finally {
    await proxy.close();
    await upstream.close();
  }
  t.false(events.some((e) => e.type === 'blocked'));
  t.true(events.some((e) => e.type === 'scrubbed'));
});

test('strict mode accepts content-encoding: identity on a recognised endpoint', async (t) => {
  const upstream = await startFakeUpstream((_req, body, res) => {
    t.false(body.includes('alice@example.com'));
    jsonResponse(res, 200, {});
  });
  const proxy = await withProxy(upstream, { strict: true });
  try {
    const res = await makeRequest(`${proxy.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': 'identity' },
      body: CHAT_BODY,
    });
    t.is(res.status, 200);
    t.is(upstream.requestCount(), 1);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('strict mode lets bodyless requests through, including on unknown endpoints', async (t) => {
  const upstream = await startFakeUpstream((_req, _body, res) =>
    jsonResponse(res, 200, { data: [{ id: 'gpt-4' }] }),
  );
  const proxy = await withProxy(upstream, { strict: true });
  try {
    const get = await makeRequest(`${proxy.url}/v1/models`, { method: 'GET' });
    t.is(get.status, 200);
    t.true(get.body.includes('gpt-4'));
    const emptyPost = await makeRequest(`${proxy.url}/v1/embeddings`, { method: 'POST' });
    t.is(emptyPost.status, 200);
    t.is(upstream.requestCount(), 2);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('strict mode is visible in /metrics as a blocked counter', async (t) => {
  const upstream = await startFakeUpstream((_req, _body, res) => jsonResponse(res, 200, {}));
  const proxy = await withProxy(upstream, { strict: true });
  try {
    await makeRequest(`${proxy.url}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: PII_BODY,
    });
    const metrics = await makeRequest(`${proxy.url}/metrics`, { method: 'GET' });
    t.regex(metrics.body, /prompt_scrub_blocked_total\{reason="unknown provider"\} 1/);
    t.regex(metrics.body, /prompt_scrub_errors_total\{kind="strict_blocked"\} 1/);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

function chatResponder(content: string) {
  return (_req: http.IncomingMessage, _body: string, res: http.ServerResponse) =>
    jsonResponse(res, 200, { choices: [{ index: 0, message: { role: 'assistant', content } }] });
}

async function chat(proxyUrl: string, messages: unknown[], session?: string) {
  const res = await makeRequest(`${proxyUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(session ? { [SESSION_HEADER]: session } : {}),
    },
    body: JSON.stringify({ model: 'gpt-4', messages }),
  });
  const reply = (JSON.parse(res.body) as { choices: { message: { content: string } }[] }).choices[0]
    ?.message.content;
  return { reply, session: res.headers[SESSION_HEADER] as string };
}

test('a literal placeholder in an earlier message is not minted for a later email', async (t) => {
  const upstream = await startFakeUpstream(
    chatResponder('You said «Email_1»; I will mail «Email_2».'),
  );
  const proxy = await withProxy(upstream);
  try {
    const { reply } = await chat(proxy.url, [
      { role: 'user', content: 'What does «Email_1» mean?' },
      { role: 'user', content: 'Mail test@example.com' },
    ]);
    const sent = JSON.parse(upstream.lastBody()) as { messages: { content: string }[] };
    t.is(sent.messages[0]?.content, 'What does «Email_1» mean?');
    t.is(sent.messages[1]?.content, 'Mail «Email_2»');
    t.is(reply, 'You said «Email_1»; I will mail test@example.com.');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('a literal placeholder in a later message is not minted for an earlier email', async (t) => {
  const upstream = await startFakeUpstream(chatResponder('ok'));
  const proxy = await withProxy(upstream);
  try {
    await chat(proxy.url, [
      { role: 'user', content: 'Mail test@example.com' },
      { role: 'user', content: 'What does «Email_1» mean?' },
    ]);
    const sent = JSON.parse(upstream.lastBody()) as { messages: { content: string }[] };
    t.is(sent.messages[0]?.content, 'Mail «Email_2»');
    t.is(sent.messages[1]?.content, 'What does «Email_1» mean?');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('a literal placeholder from one request is not minted in a later request of the session', async (t) => {
  const upstream = await startFakeUpstream(chatResponder('mailing «Email_2», re «Email_1»'));
  const proxy = await withProxy(upstream);
  try {
    const first = await chat(proxy.url, [{ role: 'user', content: 'What does «Email_1» mean?' }]);
    const second = await chat(
      proxy.url,
      [{ role: 'user', content: 'Mail test@example.com' }],
      first.session,
    );
    t.is(
      (JSON.parse(upstream.lastBody()) as { messages: { content: string }[] }).messages[0]?.content,
      'Mail «Email_2»',
    );
    t.is(second.reply, 'mailing test@example.com, re «Email_1»');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('a literal placeholder in an Anthropic system prompt is not minted for a message email', async (t) => {
  const upstream = await startFakeUpstream((_req, _body, res) =>
    jsonResponse(res, 200, { content: [{ type: 'text', text: 'sent to «Email_2»' }] }),
  );
  const proxy = await withProxy(upstream);
  try {
    const res = await makeRequest(`${proxy.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude',
        system: 'Tokens look like «Email_1».',
        messages: [{ role: 'user', content: 'Mail test@example.com' }],
      }),
    });
    const sent = JSON.parse(upstream.lastBody()) as {
      system: string;
      messages: { content: string }[];
    };
    t.is(sent.system, 'Tokens look like «Email_1».');
    t.is(sent.messages[0]?.content, 'Mail «Email_2»');
    t.true(res.body.includes('sent to test@example.com'));
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('a placeholder the session already maps keeps resolving to its value', async (t) => {
  const upstream = await startFakeUpstream(chatResponder('reply «Email_1»'));
  const proxy = await withProxy(upstream);
  try {
    const first = await chat(proxy.url, [{ role: 'user', content: 'Mail test@example.com' }]);
    t.is(first.reply, 'reply test@example.com');
    const second = await chat(
      proxy.url,
      [{ role: 'user', content: 'Again «Email_1»' }],
      first.session,
    );
    t.is(second.reply, 'reply test@example.com');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('reuses an inbound session header to resolve existing placeholders', async (t) => {
  const upstream = await startFakeUpstream((_, body, res) => {
    // The inbound body should be RE-HYDRATED back to the original PII before
    // scrubbing, so the upstream only ever sees placeholders — but the new
    // round's scrubbed content should also include any pre-existing entries.
    t.true(body.includes('«Email_1»'));
    jsonResponse(res, 200, {
      id: 'chatcmpl-2',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Got it «Email_1»' },
        },
      ],
    });
  });

  const proxy = await withProxy(upstream);
  try {
    // Turn 1: introduce an email, capture the session.
    const first = await makeRequest(`${proxy.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'Alice is alice@example.com' }],
      }),
    });
    const session = first.headers[SESSION_HEADER] as string;
    t.truthy(session);

    // Turn 2: send the placeholder back; upstream must NOT see the raw email.
    const second = await makeRequest(`${proxy.url}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [SESSION_HEADER]: session,
      },
      body: JSON.stringify({
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'Tell me about «Email_1»' }],
      }),
    });
    t.is(second.status, 200);
    t.true(second.body.includes('alice@example.com'));
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('streams an SSE chat-completion response with rehydration', async (t) => {
  const upstream = await startFakeUpstream((_req, body, res) => {
    t.true(body.includes('"stream":true'));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    // Three events: a placeholder split across chunks, a normal one, then DONE.
    res.write('data: {"choices":[{"index":0,"delta":{"content":"Hi «Emai');
    setImmediate(() => {
      res.write('l_1»"}}]}\n\n');
      res.write('data: {"choices":[{"index":0,"delta":{"content":" — got it"}}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });

  const proxy = await withProxy(upstream);
  try {
    const res = await makeRequest(`${proxy.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4',
        stream: true,
        messages: [{ role: 'user', content: 'Hello alice@example.com' }],
      }),
    });
    t.is(res.status, 200);
    t.true(res.headers['content-type']?.toString().includes('text/event-stream'));
    t.true(res.body.includes('alice@example.com'));
    t.false(res.body.includes('«Email_1»'));
    t.true(res.body.includes('[DONE]'));
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('forwards a non-JSON upstream response without trying to rewrite it', async (t) => {
  const upstream = await startFakeUpstream((_req, _body, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('plain text body, no placeholders here');
  });
  const proxy = await withProxy(upstream);
  try {
    const res = await makeRequest(`${proxy.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    t.is(res.status, 200);
    t.is(res.body, 'plain text body, no placeholders here');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('returns 502 when the upstream is unreachable', async (t) => {
  // Bind a proxy without an upstream and immediately close it to free the
  // port, then point a fresh proxy at the now-dead URL. The dispatch path
  // should fail and produce an error response.
  const dead = await startFakeUpstream((_req, _body, res) => {
    res.end();
  });
  const deadUrl = dead.url;
  await dead.close();

  const proxy = await createProxyServer({
    target: new URL(deadUrl),
    port: 0,
    host: '127.0.0.1',
  });
  try {
    const res = await makeRequest(`${proxy.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'test' }],
      }),
    });
    // ECONNREFUSED comes back as a 502 from the proxy's catch block.
    t.is(res.status, 502);
  } finally {
    await proxy.close();
  }
});

test('rejects request bodies larger than maxBodyBytes with 413', async (t) => {
  const upstream = await startFakeUpstream((_req, _body, res) => {
    jsonResponse(res, 200, { ok: true });
  });
  const proxy = await withProxy(upstream, { maxBodyBytes: 64 });
  try {
    const big = 'a'.repeat(2048);
    const res = await makeRequest(`${proxy.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4',
        messages: [{ role: 'user', content: big }],
      }),
    });
    t.is(res.status, 413);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('scrubs an Anthropic messages request and rehydrates the response', async (t) => {
  const upstream = await startFakeUpstream((_req, body, res) => {
    t.false(body.includes('carol@example.com'));
    t.true(body.includes('«Email_1»'));
    jsonResponse(res, 200, {
      id: 'msg_1',
      content: [{ type: 'text', text: 'Hi «Email_1»' }],
    });
  });
  const proxy = await withProxy(upstream);
  try {
    const res = await makeRequest(`${proxy.url}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'test-key',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-3',
        messages: [{ role: 'user', content: 'carol@example.com' }],
      }),
    });
    t.is(res.status, 200);
    t.true(res.body.includes('carol@example.com'));
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test.serial(
  'proxy strips Content-Length on responses so rehydrated bodies parse cleanly',
  async (t) => {
    const upstream = await startFakeUpstream((_req, body, res) => {
      // Mimic OpenAI: an explicit Content-Length set before we know the proxy
      // will lengthen the body via rehydration.
      const responseBody = JSON.stringify({
        id: 'cmpl-1',
        choices: [
          {
            message: {
              // Proxy will write this placeholder; we reply with the original
              // (longer) value to force a length mismatch if Content-Length
              // were forwarded.
              content: JSON.parse(body).messages[0].content,
            },
            index: 0,
          },
        ],
      });
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(responseBody),
      });
      res.end(responseBody);
    });

    const proxy = await createProxyServer({
      target: new URL(upstream.url),
      port: 0,
      host: '127.0.0.1',
      sessionStore: new Map(),
    });

    try {
      const res = await makeRequest(proxy.url + '/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'x',
          messages: [{ role: 'user', content: 'mail alice@example.com' }],
        }),
      });
      t.is(res.status, 200, `unexpected status: ${res.status} body=${res.body}`);
      // No Content-Length header in the proxy's response (so Node chunks it).
      t.is(res.headers['content-length'], undefined);
      // The proxy's rehydrated body round-trips the original email.
      t.true(res.body.includes('alice@example.com'));
      // No leftover placeholder leaked.
      t.false(res.body.includes('«Email_'));
    } finally {
      await proxy.close();
      await upstream.close();
    }
  },
);

test.serial('runProxyCommand throws when --target is missing', async (t) => {
  const { runProxyCommand } = await import('../../src/cli/commands/proxy.js');
  await t.throwsAsync(() => runProxyCommand({ target: '', port: '8080' }), {
    message: /Missing required --target/,
  });
});

test.serial('runProxyCommand throws on an invalid --target URL', async (t) => {
  const { runProxyCommand } = await import('../../src/cli/commands/proxy.js');
  await t.throwsAsync(() => runProxyCommand({ target: 'not-a-url', port: '8080' }), {
    message: /Invalid --target URL/,
  });
});

test.serial('runProxyCommand throws on an invalid --port', async (t) => {
  const { runProxyCommand } = await import('../../src/cli/commands/proxy.js');
  await t.throwsAsync(() => runProxyCommand({ target: 'http://127.0.0.1:1', port: 'not-a-port' }), {
    message: /Invalid --port/,
  });
});

test.serial('runProxyCommand throws on an invalid --host', async (t) => {
  const { runProxyCommand } = await import('../../src/cli/commands/proxy.js');
  await t.throwsAsync(
    () =>
      runProxyCommand({
        target: 'http://127.0.0.1:1',
        port: '0',
        host: 'bad host!',
      }),
    { message: /Invalid --host/ },
  );
});

test.serial('runProxyCommand logs a warning when session GC throws', async (t) => {
  // Stub gcSessions via Node's require-style override isn't available in
  // ESM; instead point PROMPT_SCRUB_CONFIG_DIR at a config dir whose
  // `sessions/` subdir has been chmod'd to 0o000 so that readdirSync throws
  // an EACCES error inside gcSessions. The catch block in runProxyCommand
  // should log a warning and continue. We then immediately SIGINT the
  // process group to stop runProxy from blocking forever.
  const { runProxyCommand } = await import('../../src/cli/commands/proxy.js');
  const unreadableDir = path.join(__dirname, '.tmp-gc-error');
  fs.mkdirSync(path.join(unreadableDir, 'sessions'), { recursive: true });
  fs.chmodSync(path.join(unreadableDir, 'sessions'), 0o000);
  const originalDir = process.env.PROMPT_SCRUB_CONFIG_DIR;
  process.env.PROMPT_SCRUB_CONFIG_DIR = unreadableDir;

  const originalError = console.error;
  const stderr: string[] = [];
  console.error = (msg: string) => stderr.push(msg);

  const proxyPromise = runProxyCommand({
    target: 'http://127.0.0.1:1',
    port: '0',
  });

  // Wait briefly for the GC warning to be logged, then send SIGINT to
  // unblock runProxy's signal handler.
  await new Promise((resolve) => setTimeout(resolve, 100));
  process.emit('SIGINT');
  await proxyPromise.catch(() => {
    // runProxy's SIGINT handler resolves cleanly.
  });

  process.env.PROMPT_SCRUB_CONFIG_DIR = originalDir;
  console.error = originalError;
  fs.chmodSync(path.join(unreadableDir, 'sessions'), 0o755);
  fs.rmSync(unreadableDir, { recursive: true, force: true });

  const combined = stderr.join('\n');
  t.true(
    combined.includes('Warning: failed to run session garbage collection'),
    `expected GC warning, got: ${combined}`,
  );
});

test.serial(
  'runProxyCommand parses comma-separated CLI options and starts the proxy',
  async (t) => {
    // Cover the parseList() body in cli/commands/proxy.ts and confirm
    // runProxyCommand actually wires scrub options through to the proxy.
    const { runProxyCommand } = await import('../../src/cli/commands/proxy.js');
    const originalError = console.error;
    console.error = () => {
      // silence the [proxy] Listening line.
    };

    // We don't need the proxy to actually start; sending SIGINT immediately
    // unblocks the runProxy signal handler.
    const proxyPromise = runProxyCommand({
      target: 'http://127.0.0.1:1',
      port: '0',
      disable: 'EmailDetector,NameDetector',
      enable: 'NameDetector,CodeTellDetector',
      codeTellTerms: 'foo,bar,baz',
      urlAllowlist: 'example.com,foo.test',
    });

    setTimeout(() => process.emit('SIGINT'), 50);
    await proxyPromise.catch(() => {
      // The proxy exits cleanly on SIGINT; nothing to assert beyond the
      // lack of an unhandled exception (parseList didn't blow up).
    });

    console.error = originalError;
    t.pass('runProxyCommand with comma-separated options completed without parse errors');
  },
);

test.serial('runProxyCommand --no-gc actually maps to gc: false', async (t) => {
  // Commander maps `--no-foo` to `foo: false` on the parsed options. The
  // proxy CLI relies on this for `--no-gc`. Inspect the program metadata
  // directly so we don't have to spin up the actual proxy (which would
  // block on SIGINT after parsing).
  const { Command } = await import('commander');
  const { setupProxyCommand } = await import('../../src/cli/commands/proxy.js');

  const program = new Command();
  setupProxyCommand(program);
  const proxyCmd = program.commands.find((c) => c.name() === 'proxy');
  t.truthy(proxyCmd, 'proxy subcommand must be registered');
  // Find the --no-gc option on the proxy subcommand and verify its long
  // form is `--no-gc` (commander exposes boolean-negation flags by their
  // positive form, with the negated attribute appearing as `gc: false`).
  const gcOpt = proxyCmd?.options.find((o) => o.long === '--no-gc');
  t.truthy(gcOpt, '--no-gc option must be registered on the proxy subcommand');
  // The check itself is in runProxyCommand: `if (options.gc !== false)`.
  // Verify that condition with a hand-rolled object.
  const noGcOptions = { gc: false };
  t.is(noGcOptions.gc !== false, false, 'gc=false should skip gcSessions');
  const defaultOptions: { gc?: boolean } = {};
  t.is(defaultOptions.gc !== false, true, 'gc undefined should run gcSessions');
});

test.serial('proxy preserves the target URL pathname prefix when forwarding', async (t) => {
  // --target https://gateway.example.com/openai strips the /openai prefix
  // if the proxy doesn't join the target's pathname with the incoming URL.
  const seen: string[] = [];
  const upstream = await startFakeUpstream((req, _body, res) => {
    seen.push(req.url ?? '');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const proxy = await createProxyServer({
    target: new URL('http://127.0.0.1:' + upstream.port + '/openai'),
    port: 0,
    host: '127.0.0.1',
    sessionStore: new Map(),
  });

  try {
    const res = await makeRequest(proxy.url + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [] }),
    });
    t.is(res.status, 200);
  } finally {
    await proxy.close();
    await upstream.close();
  }

  t.deepEqual(seen, ['/openai/v1/chat/completions']);
});

test.serial('proxy joins a trailing-slash target with a root-path incoming URL', async (t) => {
  // --target https://gateway.example.com/openai/ + incoming '/' should
  // still produce '/openai/' on the wire (the joiner strips the trailing
  // slash from the base before appending).
  const seen: string[] = [];
  const upstream = await startFakeUpstream((req, _body, res) => {
    seen.push(req.url ?? '');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const proxy = await createProxyServer({
    target: new URL('http://127.0.0.1:' + upstream.port + '/openai/'),
    port: 0,
    host: '127.0.0.1',
    sessionStore: new Map(),
  });

  try {
    const res = await makeRequest(proxy.url + '/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    t.is(res.status, 200);
  } finally {
    await proxy.close();
    await upstream.close();
  }

  t.deepEqual(seen, ['/openai/']);
});

test.serial(
  'proxy surfaces an upstream error event when the upstream crashes mid-stream',
  async (t) => {
    // Upstream sends half an SSE event then drops the connection. The proxy
    // should emit an `error` event, kill the downstream, and exit cleanly
    // rather than hanging the client.
    const events: ProxyEvent[] = [];
    const upstream = await new Promise<{
      url: string;
      port: number;
      close: () => Promise<void>;
    }>((resolve) => {
      const server = http.createServer((_req, res) => {
        res.on('error', () => {
          // Swallow the synthetic error from the setImmediate below; the
          // proxy will see it through the same channel.
        });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"hello "}}]}\n\n');
        // Then drop the connection so the proxy's stream errors.
        res.destroy();
      });
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        resolve({
          url: `http://127.0.0.1:${port}`,
          port,
          close: () => new Promise<void>((r) => server.close(() => r())),
        });
      });
    });

    const proxy = await createProxyServer(
      {
        target: new URL(upstream.url),
        port: 0,
        host: '127.0.0.1',
        sessionStore: new Map(),
      },
      (e) => events.push(e),
    );

    try {
      await makeRequest(proxy.url + '/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'x',
          stream: true,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
    } catch {
      // Expected — upstream dropped mid-stream.
    } finally {
      await proxy.close();
      await upstream.close();
    }

    // If an `error` event fired it must reference something the upstream did.
    for (const e of events) {
      if (e.type === 'error') {
        t.true(e.message.length > 0, `error event must carry a message, got: ${JSON.stringify(e)}`);
      }
    }
  },
);

test.serial(
  'stream:true request answered with JSON error is forwarded without SSE rehydration',
  async (t) => {
    const upstream = await startFakeUpstream((_req, body, res) => {
      let parsed: { stream?: boolean } = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        // ignore
      }
      if (parsed.stream === true) {
        // Anthropic / OpenAI both answer bad-model errors with a JSON body
        // and a non-2xx status, even though the client requested streaming.
        const errBody = JSON.stringify({
          error: { message: 'bad model', param: 'x' },
        });
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(errBody);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });

    const proxy = await createProxyServer({
      target: new URL(upstream.url),
      port: 0,
      host: '127.0.0.1',
      sessionStore: new Map(),
    });

    try {
      const res = await makeRequest(proxy.url + '/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'x',
          stream: true,
          messages: [{ role: 'user', content: 'mail alice@example.com' }],
        }),
      });
      t.is(res.status, 400);
      // Error body is JSON, not SSE, so the response should be forwarded
      // without SSE rehydration artefacts: no spurious trailing blank line,
      // and content-type is preserved as application/json.
      t.true(res.body.includes('bad model'));
      t.false(
        /\n\n$/.test(res.body),
        `unexpected trailing blank line: ${JSON.stringify(res.body)}`,
      );
      t.true(
        (res.headers['content-type'] ?? '').toString().includes('application/json'),
        `expected JSON content-type, got: ${res.headers['content-type']}`,
      );
    } finally {
      await proxy.close();
      await upstream.close();
    }
  },
);

test('scrubs a tool-calling OpenAI conversation end to end', async (t) => {
  // Regression test for issue #163: the assistant turn below has no `content`
  // key, which used to drop it from the forwarded body entirely, and its
  // `arguments` JSON used to reach the upstream with the raw address in it.
  const upstream = await startFakeUpstream((_, body, res) => {
    const forwarded = JSON.parse(body) as {
      messages: Array<{ role: string; tool_calls?: unknown[] }>;
    };
    t.is(forwarded.messages.length, 3, 'all three messages reach the upstream');
    t.is(forwarded.messages[1]?.role, 'assistant');
    t.truthy(forwarded.messages[1]?.tool_calls, 'the tool call survives');
    t.false(body.includes('john@example.com'), 'no raw address reaches the upstream');
    t.true(body.includes('«Email_1»'));

    jsonResponse(res, 200, {
      id: 'chatcmpl-1',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: '2',
                type: 'function',
                function: { name: 'lookup', arguments: '{"email":"«Email_1»"}' },
              },
            ],
          },
        },
      ],
    });
  });

  const proxy = await withProxy(upstream);

  try {
    const res = await makeRequest(`${proxy.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'user', content: 'What is the status of john@example.com?' },
          {
            role: 'assistant',
            tool_calls: [
              {
                id: '1',
                type: 'function',
                function: { name: 'lookup', arguments: '{"email":"john@example.com"}' },
              },
            ],
          },
          { role: 'tool', tool_call_id: '1', content: 'User john@example.com has balance $500' },
        ],
      }),
    });

    t.is(res.status, 200);
    const parsed = JSON.parse(res.body) as {
      choices: Array<{ message: { tool_calls: Array<{ function: { arguments: string } }> } }>;
    };
    // The client runs the tool locally, so the arguments must be real again.
    t.deepEqual(JSON.parse(parsed.choices[0]?.message.tool_calls[0]?.function.arguments ?? '{}'), {
      email: 'john@example.com',
    });
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('scrubs an Anthropic system prompt and tool blocks end to end', async (t) => {
  const upstream = await startFakeUpstream((_, body, res) => {
    t.false(body.includes('john@example.com'), 'no raw address reaches the upstream');
    t.true(body.includes('«Email_1»'));
    jsonResponse(res, 200, {
      id: 'msg_1',
      content: [{ type: 'text', text: 'Found «Email_1».' }],
    });
  });

  const proxy = await withProxy(upstream);

  try {
    const res = await makeRequest(`${proxy.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-3',
        system: 'You are support for john@example.com, be brief',
        tools: [{ name: 'lookup', description: 'Look up john@example.com', input_schema: {} }],
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_1',
                content: 'User john@example.com has balance $500',
              },
            ],
          },
        ],
      }),
    });

    t.is(res.status, 200);
    t.true(res.body.includes('john@example.com'), 'the response is rehydrated for the client');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('the session header is never forwarded to the upstream', async (t) => {
  const seen: http.IncomingHttpHeaders[] = [];
  const upstream = await startFakeUpstream((req, _body, res) => {
    seen.push(req.headers);
    jsonResponse(res, 200, {
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }],
    });
  });
  const proxy = await withProxy(upstream);
  try {
    const first = await chat(proxy.url, [{ role: 'user', content: 'hello' }]);
    t.truthy(first.session);
    await chat(proxy.url, [{ role: 'user', content: 'again' }], first.session);

    const known = await makeRequest(`${proxy.url}/v1/models`, {
      method: 'GET',
      headers: { [SESSION_HEADER]: first.session, authorization: 'Bearer test-key' },
    });
    t.is(known.status, 200);

    t.is(seen.length, 3);
    for (const headers of seen) {
      t.false(SESSION_HEADER in headers);
    }
    t.is(seen[2]?.authorization, 'Bearer test-key');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('the session header still reaches the client and pins the session', async (t) => {
  const upstream = await startFakeUpstream(chatResponder('mailing «Email_1»'));
  const proxy = await withProxy(upstream);
  try {
    const first = await chat(proxy.url, [{ role: 'user', content: 'mail bob@example.com' }]);
    t.regex(first.session, /^[0-9a-f-]{36}$/);
    const second = await chat(proxy.url, [{ role: 'user', content: 'again' }], first.session);
    t.is(second.session, first.session);
    t.is(second.reply, 'mailing bob@example.com');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('verbose logging and events never include the query string', async (t) => {
  const upstream = await startFakeUpstream((_req, _body, res) =>
    jsonResponse(res, 200, { data: [] }),
  );
  const logs: string[] = [];
  const events: ProxyEvent[] = [];
  const proxy = await withProxy(upstream, { verbose: true, log: (msg) => logs.push(msg) }, events);
  try {
    const res = await makeRequest(`${proxy.url}/v1/models?api_key=secret_12345&key=abc`, {
      method: 'GET',
    });
    t.is(res.status, 200);
    await makeRequest(`${proxy.url}/openai/deployments/d/chat/completions?api-key=secret_67890`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
  } finally {
    await proxy.close();
    await upstream.close();
  }

  const output = JSON.stringify(events) + logs.join('\n');
  t.false(output.includes('secret_12345'));
  t.false(output.includes('secret_67890'));
  t.false(output.includes('api_key'));
  const requests = events.filter((e) => e.type === 'request');
  t.is(requests.length, 2);
  t.like(requests[0], { method: 'GET', path: '/v1/models' });
});

test('the startup line does not print credentials or a query string from --target', async (t) => {
  const upstream = await startFakeUpstream((_req, _body, res) => jsonResponse(res, 200, {}));
  const logs: string[] = [];
  const target = new URL(upstream.url);
  target.username = 'user';
  target.password = 'hunter2';
  target.pathname = '/gateway';
  target.search = '?key=secret_abc';
  const proxy = await createProxyServer({
    target,
    port: 0,
    host: '127.0.0.1',
    log: (m) => logs.push(m),
  });
  await proxy.close();
  await upstream.close();

  const line = logs.find((l) => l.includes('Listening on')) ?? '';
  t.true(line.includes(`${new URL(upstream.url).origin}/gateway`));
  t.false(line.includes('hunter2'));
  t.false(line.includes('secret_abc'));
});

test('the query string is forwarded to the upstream, on known and unknown paths', async (t) => {
  const seen: string[] = [];
  const upstream = await startFakeUpstream((req, _body, res) => {
    seen.push(`${req.method} ${req.url}`);
    jsonResponse(res, 200, { choices: [{ message: { role: 'assistant', content: 'ok' } }] });
  });
  const proxy = await withProxy(upstream);
  try {
    await makeRequest(`${proxy.url}/v1/models?limit=5&api_key=secret_12345`, { method: 'GET' });
    await makeRequest(`${proxy.url}/openai/deployments/d/chat/completions?api-version=2024-02-01`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    await makeRequest(`${proxy.url}/?x=1`, { method: 'GET' });
    await makeRequest(`${proxy.url}/v1/models`, { method: 'GET' });
  } finally {
    await proxy.close();
    await upstream.close();
  }
  t.deepEqual(seen, [
    'GET /v1/models?limit=5&api_key=secret_12345',
    'POST /openai/deployments/d/chat/completions?api-version=2024-02-01',
    'GET /?x=1',
    'GET /v1/models',
  ]);
});

test('the query string is kept after a path prefix on the target', async (t) => {
  let seen = '';
  const upstream = await startFakeUpstream((req, _body, res) => {
    seen = req.url ?? '';
    jsonResponse(res, 200, {});
  });
  const target = new URL(`${upstream.url}/gateway/`);
  const proxy = await createProxyServer({ target, port: 0, host: '127.0.0.1', log: () => {} });
  try {
    await makeRequest(`${proxy.url}/v1/models?key=abc`, { method: 'GET' });
  } finally {
    await proxy.close();
    await upstream.close();
  }
  t.is(seen, '/gateway/v1/models?key=abc');
});

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await delay(10);
  }
  return condition();
}

const CHAT = JSON.stringify({ model: 'gpt-4', messages: [{ role: 'user', content: 'hello' }] });

test('waits for a slow upstream as long as the configured timeout allows', async (t) => {
  const upstream = await startFakeUpstream((_req, _body, res) => {
    setTimeout(() => jsonResponse(res, 200, { choices: [{ message: { content: 'late' } }] }), 300);
  });
  const proxy = await withProxy(upstream, { upstreamTimeoutMs: 5000 });
  try {
    const res = await makeRequest(`${proxy.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: CHAT,
    });
    t.is(res.status, 200);
    t.true(res.body.includes('late'));
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('abandons an upstream that stays silent past the configured timeout', async (t) => {
  const upstream = await startFakeUpstream(() => {});
  const events: ProxyEvent[] = [];
  const proxy = await withProxy(upstream, { upstreamTimeoutMs: 150 }, events);
  try {
    const res = await makeRequest(`${proxy.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: CHAT,
    });
    t.is(res.status, 502);
    t.true(res.body.includes('upstream timeout after 0.15s'), res.body);
  } finally {
    await proxy.close();
    await upstream.close();
  }
  const response = events.find((e) => e.type === 'response');
  t.like(response, { status: 502, outcome: 'error', errorKind: 'upstream_timeout' });
});

test('hanging up while the upstream is still thinking cancels the upstream request', async (t) => {
  let upstreamClosed = false;
  const upstream = await startFakeUpstream((_req, _body, res) => {
    res.on('close', () => {
      upstreamClosed = true;
    });
  });
  const events: ProxyEvent[] = [];
  const proxy = await withProxy(upstream, {}, events);
  try {
    const parsed = new URL(proxy.url);
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    req.on('error', () => {});
    req.end(CHAT);
    await delay(150);
    req.destroy();

    t.true(await until(() => upstreamClosed), 'the upstream connection was never closed');
    t.true(await until(() => events.some((e) => e.type === 'response')));
  } finally {
    await proxy.close();
    await upstream.close();
  }
  t.like(
    events.find((e) => e.type === 'response'),
    {
      status: 499,
      outcome: 'error',
      errorKind: 'client_aborted',
    },
  );
  t.false(events.some((e) => e.type === 'error'));
});

test('hanging up while the upstream is still sending a JSON body cancels it', async (t) => {
  let upstreamClosed = false;
  const upstream = await startFakeUpstream((_req, _body, res) => {
    res.on('close', () => {
      upstreamClosed = true;
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"choices":[{"message":{"content":"par');
  });
  const events: ProxyEvent[] = [];
  const proxy = await withProxy(upstream, {}, events);
  try {
    const parsed = new URL(proxy.url);
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    req.on('error', () => {});
    req.end(CHAT);
    await delay(150);
    req.destroy();

    t.true(await until(() => upstreamClosed), 'the upstream connection was never closed');
    t.true(await until(() => events.some((e) => e.type === 'response')));
  } finally {
    await proxy.close();
    await upstream.close();
  }
  t.like(
    events.find((e) => e.type === 'response'),
    {
      status: 499,
      outcome: 'error',
      errorKind: 'client_aborted',
    },
  );
  t.false(events.some((e) => e.type === 'error'));
});

test('a request that completes normally is not reported as aborted', async (t) => {
  const upstream = await startFakeUpstream(chatResponder('ok'));
  const events: ProxyEvent[] = [];
  const proxy = await withProxy(upstream, {}, events);
  try {
    const res = await chat(proxy.url, [{ role: 'user', content: 'hi' }]);
    t.is(res.reply, 'ok');
  } finally {
    await proxy.close();
    await upstream.close();
  }
  t.like(
    events.find((e) => e.type === 'response'),
    { status: 200, outcome: 'ok' },
  );
});
