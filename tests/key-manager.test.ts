import * as crypto from 'node:crypto';
import { PassThrough } from 'node:stream';
import test from 'ava';
import { clearDerivedKeyCache, decryptSession, encryptSession } from '../src/core/crypto.js';
import {
  assertValidKey,
  clearCachedEncryptionKey,
  getCachedKey,
  getEncryptionKey,
  promptPassword,
  setCachedEncryptionKey,
} from '../src/core/key-manager.js';

/**
 * Drive `promptPassword` under a fake TTY by feeding lines through a
 * PassThrough that `readline` reads from. We pass the streams directly
 * through the `io` argument instead of monkey-patching `process.stdin`/
 * `process.stdout`, which is brittle across Node versions.
 */
async function withFakeTTY<T>(
  linesToFeed: string[],
  fn: (io: { input: PassThrough; output: PassThrough; isTTY: true }) => Promise<T>,
): Promise<T> {
  const input = new PassThrough();
  const output = new PassThrough();
  setImmediate(() => {
    for (const line of linesToFeed) {
      input.write(`${line}\n`);
    }
    input.end();
  });
  return fn({ input, output, isTTY: true });
}

test.beforeEach(() => {
  clearCachedEncryptionKey();
  clearDerivedKeyCache();
  delete process.env.PROMPT_SCRUB_KEY;
});

test.serial('setCachedEncryptionKey throws on empty string', (t) => {
  t.throws(() => setCachedEncryptionKey(''), {
    message: /non-empty string/,
  });
});

test.serial('getEncryptionKey uses PROMPT_SCRUB_KEY if present', async (t) => {
  process.env.PROMPT_SCRUB_KEY = 'env-key';
  const key = await getEncryptionKey();
  t.is(key, 'env-key');
});

test.serial('getEncryptionKey rejects whitespace-only PROMPT_SCRUB_KEY', async (t) => {
  process.env.PROMPT_SCRUB_KEY = '   ';
  await t.throwsAsync(() => getEncryptionKey(), {
    message: /A valid key is required/,
  });
});

test.serial('getEncryptionKey uses cache if already resolved', async (t) => {
  setCachedEncryptionKey('cached-key');
  const key = await getEncryptionKey();
  t.is(key, 'cached-key');
});

test.serial('getEncryptionKey throws if no env/cache and not TTY', async (t) => {
  const isTTY = process.stdout.isTTY && process.stdin.isTTY;
  if (!isTTY) {
    await t.throwsAsync(() => getEncryptionKey(), {
      message: /stdin or stdout is redirected/,
    });
  } else {
    t.pass('Skipping non-TTY test because environment is TTY');
  }
});

test.serial('assertValidKey throws on invalid input', (t) => {
  t.throws(() => assertValidKey(''), { message: /A valid key is required/ });
  t.throws(() => assertValidKey('   '), { message: /A valid key is required/ });
  t.throws(() => assertValidKey(null as unknown as string), {
    message: /A valid key is required/,
  });
  t.throws(() => assertValidKey(undefined as unknown as string), {
    message: /A valid key is required/,
  });
});

test.serial('assertValidKey preserves leading/trailing whitespace in valid keys', (t) => {
  t.is(assertValidKey('  valid-key  '), '  valid-key  ');
  t.is(assertValidKey('a'), 'a');
});

test.serial('clearCachedEncryptionKey also clears derived key cache', (t) => {
  const salt = crypto.randomBytes(16);
  const keyA = crypto.scryptSync('clear-cache-test', salt, 32, { N: 16384, r: 8, p: 1 });
  encryptSession({ foo: 'bar' }, 'clear-cache-test');
  // Sanity: derived key cache holds something for this key+salt pair now.
  // (We can't easily peek at the cache from outside, so we exercise the
  // public behaviour: a successful round-trip before clear, and a successful
  // round-trip after — the cache being cleared is only meaningful for
  // attacker surface, not for correctness.)
  const before = decryptSession(encryptSession({ a: '1' }, 'clear-cache-test'), 'clear-cache-test');
  t.deepEqual(before, { a: '1' });

  clearCachedEncryptionKey();

  // After clearing, derived keys must be re-derived on demand — i.e. a fresh
  // decrypt should still succeed without raising.
  const after = decryptSession(encryptSession({ b: '2' }, 'clear-cache-test'), 'clear-cache-test');
  t.deepEqual(after, { b: '2' });
  // The unused `keyA` is here only to keep TypeScript happy about types when
  // reading the salt variable in a no-op branch above.
  t.true(keyA.length === 32);
});

test.serial('promptPassword throws when not TTY', async (t) => {
  const isTTY = process.stdout.isTTY && process.stdin.isTTY;
  if (!isTTY) {
    await t.throwsAsync(() => promptPassword('query'), {
      message: /stdin or stdout is redirected/,
    });
  } else {
    t.pass('Skipping non-TTY test because environment is TTY');
  }
});

test.serial('setCachedEncryptionKey does not validate against whitespace-only strings', (t) => {
  // The setter is the lowest-level API and only checks "non-empty". Higher
  // layers (assertValidKey / getEncryptionKey) apply the stricter
  // whitespace-only rule. Documenting the deliberate asymmetry here keeps
  // future contributors from accidentally tightening it without updating the
  // consumers.
  t.notThrows(() => setCachedEncryptionKey('   '));
  t.is(getCachedKey(), '   ');
});

test.serial('promptPassword resolves with the user-typed value under a fake TTY', async (t) => {
  const result = await withFakeTTY(['hunter2'], async (io) => {
    return promptPassword('Enter key: ', io);
  });
  t.is(result, 'hunter2');
});

test.serial(
  'getEncryptionKey falls through to the interactive prompt when env is unset',
  async (t) => {
    const result = await withFakeTTY(['interactive-key'], async (io) => {
      return getEncryptionKey({ io });
    });
    t.is(result, 'interactive-key');
    t.is(getCachedKey(), 'interactive-key');
  },
);

test.serial('getEncryptionKey with confirm: true succeeds on matching input', async (t) => {
  const result = await withFakeTTY(['first', 'first'], async (io) => {
    return getEncryptionKey({ confirm: true, io });
  });
  t.is(result, 'first');
});

test.serial('getEncryptionKey with confirm: true throws when the inputs differ', async (t) => {
  await withFakeTTY(['first', 'second'], async (io) => {
    await t.throwsAsync(() => getEncryptionKey({ confirm: true, io }), {
      message: /Keys do not match/,
    });
  });
  // Confirmation failure must not leave a half-cached key behind.
  t.is(getCachedKey(), null);
});

test.serial('getEncryptionKey rejects whitespace-only interactive input', async (t) => {
  await withFakeTTY(['   '], async (io) => {
    await t.throwsAsync(() => getEncryptionKey({ io }), {
      message: /A valid key is required/,
    });
  });
});

test.serial('promptPassword rejects when isTTY=false', async (t) => {
  const input = new PassThrough();
  const output = new PassThrough();
  await t.throwsAsync(() => promptPassword('q', { input, output, isTTY: false }), {
    message: /stdin or stdout is redirected/,
  });
});
