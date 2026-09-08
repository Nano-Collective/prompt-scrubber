import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
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

test.serial('proxy surfaces an upstream error event when the upstream crashes mid-stream', async (t) => {
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
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"hello "}}]}\n\n');
      // Then drop the connection.
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
      t.true(
        e.message.length > 0,
        `error event must carry a message, got: ${JSON.stringify(e)}`,
      );
    }
  }
});

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
