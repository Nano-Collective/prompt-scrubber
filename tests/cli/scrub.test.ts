import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'ava';
import { formatScrubSummary, handleScrub, parseConfidence } from '../../src/cli/commands/scrub.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const tmpConfigDir = path.join(__dirname, '.tmp-config-cli-scrub');

test.before(() => {
  // Isolate session storage to a temp dir so tests never touch the user's real
  // config dir. PROMPT_SCRUB_CONFIG_DIR is honored on every platform.
  process.env.PROMPT_SCRUB_CONFIG_DIR = tmpConfigDir;
  if (fs.existsSync(tmpConfigDir)) {
    fs.rmSync(tmpConfigDir, { recursive: true, force: true });
  }
});

test.after.always(() => {
  if (fs.existsSync(tmpConfigDir)) {
    fs.rmSync(tmpConfigDir, { recursive: true, force: true });
  }
});

test('handleScrub processes text and returns result', async (t) => {
  const result = await handleScrub('My email is test@example.com', {});
  t.is(result.scrubbedContent, 'My email is «Email_1»');
  t.truthy(result.sessionId);
});

test('handleScrub respects disabled detectors', async (t) => {
  const result = await handleScrub('Email alice@example.com', {
    sessionId: 'test-session',
    disable: 'EmailDetector',
  });
  t.is(result.scrubbedContent, 'Email alice@example.com'); // unscrubbed
});

test('handleScrub uses provided sessionId', async (t) => {
  const result = await handleScrub('Email alice@example.com', { sessionId: 'test-session-2' });
  t.is(result.sessionId, 'test-session-2');
});

test('handleScrub respects enabled detectors', async (t) => {
  const result = await handleScrub('say hello to Alice.', {
    enable: 'NameDetector',
  });
  t.is(result.scrubbedContent, 'say hello to «Name_1».');
});

test('handleScrub respects strictName option', async (t) => {
  const result = await handleScrub('hello John.', {
    enable: 'NameDetector',
    strictName: true,
  });
  t.is(result.scrubbedContent, 'hello «Name_1».');
});

test('handleScrub respects codeTellTerms', async (t) => {
  const result = await handleScrub('const myVar = 1;', {
    codeTellTerms: 'myVar, otherVar',
  });
  t.is(result.scrubbedContent, 'const «CodeTell_1» = 1;');
});

import { Command } from 'commander';
import { setupScrubCommand } from '../../src/cli/commands/scrub.js';

test.serial('scrub command fails when file is unreadable', async (t) => {
  const program = new Command();
  setupScrubCommand(program);

  const originalExit = process.exit;
  const originalError = console.error;
  let exitCode: number | undefined;
  let errorOutput = '';

  process.exit = ((code?: number) => {
    exitCode = code;
  }) as unknown as typeof process.exit;
  console.error = (msg: string) => {
    errorOutput += msg;
  };

  await program.parseAsync(['node', 'test', 'scrub', 'non-existent-file-999.txt']);

  process.exit = originalExit;
  console.error = originalError;

  t.is(exitCode, 1);
  t.true(errorOutput.includes('Error reading file'));
});

test.serial('scrub command fails when no stdin is provided', async (t) => {
  const program = new Command();
  setupScrubCommand(program);

  const originalExit = process.exit;
  const originalError = console.error;
  let exitCode: number | undefined;
  let errorOutput = '';

  process.exit = ((code?: number) => {
    exitCode = code;
  }) as unknown as typeof process.exit;
  console.error = (msg: string) => {
    errorOutput += msg;
  };

  await program.parseAsync(['node', 'test', 'scrub']);

  process.exit = originalExit;
  console.error = originalError;

  t.is(exitCode, 1);
  t.true(errorOutput.includes('No input provided'));
});

test('formatScrubSummary renders counts, plurals and the empty case', (t) => {
  t.is(formatScrubSummary({ totalEntities: 0, byCategory: {} }), 'Scrubbed: 0 entities');
  t.is(
    formatScrubSummary({ totalEntities: 1, byCategory: { Email: 1 } }),
    'Scrubbed: 1 entity (1 Email)',
  );
  t.is(
    formatScrubSummary({ totalEntities: 3, byCategory: { Email: 1, Secret: 2 } }),
    'Scrubbed: 3 entities (1 Email, 2 Secrets)',
  );
  t.is(
    formatScrubSummary({ totalEntities: 4, byCategory: { Address: 2, Identity: 2 } }),
    'Scrubbed: 4 entities (2 Addresses, 2 Identities)',
  );
});

test('handleScrub returns stats alongside the scrubbed content', async (t) => {
  const result = await handleScrub('Mail alice@example.com and bob@example.com', {});
  t.is(result.stats.totalEntities, 2);
  t.deepEqual(result.stats.byCategory, { Email: 2 });
});

test('handleScrub applies minConfidence before scrubbing', async (t) => {
  const text = 'ask Alice about alice@example.com';

  const all = await handleScrub(text, { enable: 'NameDetector' });
  t.is(all.scrubbedContent, 'ask «Name_1» about «Email_1»');

  const filtered = await handleScrub(text, { enable: 'NameDetector', minConfidence: 0.8 });
  t.is(filtered.scrubbedContent, 'ask Alice about «Email_1»');
});

test('parseConfidence accepts the 0-1 range and rejects anything else', (t) => {
  t.is(parseConfidence('0'), 0);
  t.is(parseConfidence('0.85'), 0.85);
  t.is(parseConfidence('1'), 1);

  for (const bad of ['-0.1', '1.1', 'high', '']) {
    t.throws(() => parseConfidence(bad), { message: 'Expected a number between 0 and 1.' });
  }
});
