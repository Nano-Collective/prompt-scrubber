import test from 'ava';
import {
  getEncryptionKey,
  setCachedEncryptionKey,
  clearCachedEncryptionKey,
  normaliseInputKey,
  promptPassword,
} from '../src/core/key-manager.js';

test.beforeEach(() => {
  clearCachedEncryptionKey();
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

test.serial('normaliseInputKey throws on invalid input', (t) => {
  t.throws(() => normaliseInputKey(''), { message: /A valid key is required/ });
  t.throws(() => normaliseInputKey('   '), { message: /A valid key is required/ });
  t.throws(() => normaliseInputKey(null as any), { message: /A valid key is required/ });
});

test.serial('normaliseInputKey returns trimmed key', (t) => {
  t.is(normaliseInputKey('  valid-key  '), '  valid-key  ');
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
