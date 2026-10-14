import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'ava';
import { createProxyServer } from '../../src/proxy/proxy-server.js';
import type { ProxyEvent, ProxyHandle, ProxyOptions } from '../../src/proxy/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const configDir = path.join(__dirname, '.tmp-config-reload');

interface FakeUpstream {
  url: string;
  close: () => Promise<void>;
  lastBody: () => string;
}

function startFakeUpstream(): Promise<FakeUpstream> {
  return new Promise((resolve) => {
    let last = '';
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        last = Buffer.concat(chunks).toString('utf8');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
      });
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
        lastBody: () => last,
      });
    });
  });
}

function postChat(url: string, content: string, sessionId?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ messages: [{ role: 'user', content }] });
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: new URL(url).port,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(sessionId ? { 'x-prompt-scrub-session': sessionId } : {}),
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForEvent(
  events: ProxyEvent[],
  predicate: (e: ProxyEvent) => boolean,
  timeoutMs = 3000,
): Promise<ProxyEvent> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = events.find(predicate);
    if (hit) return hit;
    await sleep(20);
  }
  throw new Error('timed out waiting for a proxy event');
}

function writeConfig(content: unknown): void {
  fs.mkdirSync(configDir, { recursive: true });
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  fs.writeFileSync(path.join(configDir, 'config.json'), text, 'utf8');
}

async function startProxy(
  upstream: FakeUpstream,
  options: Partial<ProxyOptions> = {},
  events: ProxyEvent[] = [],
): Promise<ProxyHandle> {
  return createProxyServer(
    {
      target: new URL(upstream.url),
      port: 0,
      host: '127.0.0.1',
      reloadConfig: true,
      ...options,
    },
    (e) => {
      events.push(e);
    },
  );
}

const isReload = (e: ProxyEvent) =>
  e.type === 'config_reloaded' || e.type === 'config_reload_failed';

test.before(() => {
  process.env.PROMPT_SCRUB_CONFIG_DIR = configDir;
});

test.after.always(async () => {
  await fs.promises.rm(configDir, { recursive: true, force: true });
});

test.serial(
  'an allowlist change applies on SIGHUP without a restart, and removing it reverses it',
  async (t) => {
    writeConfig({});
    const upstream = await startFakeUpstream();
    const events: ProxyEvent[] = [];
    const proxy = await startProxy(upstream, {}, events);
    try {
      await postChat(proxy.url, 'see https://docs.example.org/page');
      t.false(upstream.lastBody().includes('docs.example.org'));

      writeConfig({ urlAllowlist: ['example.org'] });
      process.emit('SIGHUP');
      await waitForEvent(events, (e) => e.type === 'config_reloaded');
      await postChat(proxy.url, 'see https://docs.example.org/page');
      t.true(upstream.lastBody().includes('docs.example.org/page'));

      writeConfig({});
      process.emit('SIGHUP');
      const reloadsBefore = events.filter((e) => e.type === 'config_reloaded').length;
      while (events.filter((e) => e.type === 'config_reloaded').length <= reloadsBefore) {
        await sleep(20);
      }
      await postChat(proxy.url, 'see https://docs.example.org/page');
      t.false(upstream.lastBody().includes('docs.example.org'));
    } finally {
      await proxy.close();
      await upstream.close();
    }
  },
);

test.serial('saving config.json applies the change through the file watcher', async (t) => {
  writeConfig({});
  const upstream = await startFakeUpstream();
  const events: ProxyEvent[] = [];
  const proxy = await startProxy(upstream, {}, events);
  try {
    writeConfig({ urlAllowlist: ['example.org'] });
    const event = await waitForEvent(events, (e) => e.type === 'config_reloaded');
    t.is(event.type === 'config_reloaded' ? event.trigger : undefined, 'watch');
    await postChat(proxy.url, 'see https://docs.example.org/page');
    t.true(upstream.lastBody().includes('docs.example.org/page'));
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test.serial('an invalid config keeps the previous configuration in force', async (t) => {
  writeConfig({ urlAllowlist: ['example.org'] });
  const upstream = await startFakeUpstream();
  const events: ProxyEvent[] = [];
  const proxy = await startProxy(upstream, {}, events);
  try {
    writeConfig('{ not valid json');
    process.emit('SIGHUP');
    const event = await waitForEvent(events, (e) => e.type === 'config_reload_failed');
    t.regex(event.type === 'config_reload_failed' ? event.reason : '', /keeping the previous/);
    await postChat(proxy.url, 'see https://docs.example.org/page');
    t.true(upstream.lastBody().includes('docs.example.org/page'));
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test.serial('a reload with an unchanged file does nothing', async (t) => {
  writeConfig({ urlAllowlist: ['example.org'] });
  const upstream = await startFakeUpstream();
  const events: ProxyEvent[] = [];
  const proxy = await startProxy(upstream, {}, events);
  try {
    process.emit('SIGHUP');
    await sleep(300);
    t.is(events.filter(isReload).length, 0);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test.serial('sessions and their placeholders survive a reload', async (t) => {
  writeConfig({});
  const upstream = await startFakeUpstream();
  const events: ProxyEvent[] = [];
  const sessionStore = new Map<string, Record<string, string>>();
  const proxy = await startProxy(upstream, { sessionStore }, events);
  try {
    const sessionId = '6f1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
    await postChat(proxy.url, 'mail alice@example.com', sessionId);
    const before = sessionStore.get(sessionId);
    t.truthy(before && Object.keys(before).length > 0);

    writeConfig({ urlAllowlist: ['example.org'] });
    process.emit('SIGHUP');
    await waitForEvent(events, (e) => e.type === 'config_reloaded');
    t.deepEqual(sessionStore.get(sessionId), before);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test.serial('a rule pack added through a reload starts scrubbing new text', async (t) => {
  writeConfig({});
  const packDir = path.join(configDir, 'packs');
  fs.mkdirSync(packDir, { recursive: true });
  const packPath = path.join(packDir, 'widget-pack.mjs');
  fs.writeFileSync(
    packPath,
    `export const detectors = [{ name: 'Widget', detect(text) {
  const out = []; const re = /WIDGET-\\d+/g; let m;
  while ((m = re.exec(text))) out.push({ category: 'Widget', span: [m.index, m.index + m[0].length], value: m[0], placeholderPrefix: 'Widget' });
  return out;
} }];\n`,
    'utf8',
  );

  const upstream = await startFakeUpstream();
  const events: ProxyEvent[] = [];
  const proxy = await startProxy(upstream, {}, events);
  try {
    await postChat(proxy.url, 'part WIDGET-42 here');
    t.true(upstream.lastBody().includes('WIDGET-42'));

    writeConfig({ rulePacks: [pathToFileURL(packPath).href] });
    process.emit('SIGHUP');
    await waitForEvent(events, (e) => e.type === 'config_reloaded');
    await postChat(proxy.url, 'part WIDGET-42 here');
    t.false(upstream.lastBody().includes('WIDGET-42'));
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test.serial('a rule pack that fails to load rejects the reload', async (t) => {
  writeConfig({});
  const upstream = await startFakeUpstream();
  const events: ProxyEvent[] = [];
  const proxy = await startProxy(upstream, {}, events);
  try {
    writeConfig({ rulePacks: ['@prompt-scrub/does-not-exist-pack'] });
    process.emit('SIGHUP');
    const event = await waitForEvent(events, (e) => e.type === 'config_reload_failed');
    t.regex(event.type === 'config_reload_failed' ? event.reason : '', /failed to load/);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test.serial('closing the proxy removes its SIGHUP listener', async (t) => {
  writeConfig({});
  const upstream = await startFakeUpstream();
  const baseline = process.listenerCount('SIGHUP');
  const proxy = await startProxy(upstream);
  t.is(process.listenerCount('SIGHUP'), baseline + 1);
  await proxy.close();
  t.is(process.listenerCount('SIGHUP'), baseline);
  await upstream.close();
});

test.serial('reloadConfig false ignores SIGHUP and registers no listener', async (t) => {
  writeConfig({});
  const upstream = await startFakeUpstream();
  const events: ProxyEvent[] = [];
  const baseline = process.listenerCount('SIGHUP');
  const proxy = await startProxy(upstream, { reloadConfig: false }, events);
  try {
    t.is(process.listenerCount('SIGHUP'), baseline);
    writeConfig({ urlAllowlist: ['example.org'] });
    process.emit('SIGHUP');
    await sleep(300);
    t.is(events.filter(isReload).length, 0);
    await postChat(proxy.url, 'see https://docs.example.org/page');
    t.false(upstream.lastBody().includes('docs.example.org'));
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test.serial('a missing config directory still starts the proxy', async (t) => {
  const missing = path.join(__dirname, '.tmp-config-reload-missing');
  process.env.PROMPT_SCRUB_CONFIG_DIR = missing;
  const upstream = await startFakeUpstream();
  const logs: string[] = [];
  try {
    const proxy = await startProxy(upstream, { log: (msg) => logs.push(msg) });
    t.true(logs.some((line) => line.includes('Config reload enabled (SIGHUP)')));
    await proxy.close();
    t.pass();
  } finally {
    process.env.PROMPT_SCRUB_CONFIG_DIR = configDir;
    await upstream.close();
  }
});
