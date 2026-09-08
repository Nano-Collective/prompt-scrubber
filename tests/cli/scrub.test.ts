import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'ava';
import { formatScrubSummary, handleScrub } from '../../src/cli/commands/scrub.js';

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

test('scrub runs the diagnostics walk with --enable set', async (t) => {
  const program = new Command();
  setupScrubCommand(program);

  const originalError = console.error;
  const errorOutput: string[] = [];
  console.error = (msg: string) => {
    errorOutput.push(msg);
  };

  const originalExit = process.exit;
  process.exit = (() => {}) as unknown as typeof process.exit;

  const tmpFile = path.join(__dirname, '.tmp-with-enable.txt');
  fs.writeFileSync(tmpFile, 'plain text with no detector matches', 'utf8');

  try {
    await program.parseAsync(['node', 'test', 'scrub', tmpFile, '--enable', 'CodeTellDetector']);
  } finally {
    process.exit = originalExit;
    console.error = originalError;
    fs.rmSync(tmpFile, { force: true });
  }

  // The diagnostic walk runs without throwing even when CodeTellDetector
  // is in --enable but no --code-tell-terms is provided.
  t.pass('diagnostics walk did not throw');
});

test('scrub runs the diagnostics walk without --disable or --enable set', async (t) => {
  const program = new Command();
  setupScrubCommand(program);

  const originalError = console.error;
  const errorOutput: string[] = [];
  console.error = (msg: string) => {
    errorOutput.push(msg);
  };

  const originalExit = process.exit;
  process.exit = (() => {}) as unknown as typeof process.exit;

  const tmpFile = path.join(__dirname, '.tmp-no-disable-enable.txt');
  fs.writeFileSync(tmpFile, 'plain text with no detector matches', 'utf8');

  try {
    await program.parseAsync(['node', 'test', 'scrub', tmpFile]);
  } finally {
    process.exit = originalExit;
    console.error = originalError;
    fs.rmSync(tmpFile, { force: true });
  }

  // No CodeTell warnings expected when --code-tell-terms is absent.
  const combined = errorOutput.join('\n');
  t.false(
    combined.includes('CodeTellDetector dropped'),
    `expected no CodeTell warnings, got: ${combined}`,
  );
});

test('scrub warns on stderr when a configured CodeTell term exceeds MAX_TERM_LENGTH', async (t) => {
  const program = new Command();
  setupScrubCommand(program);

  const originalError = console.error;
  const errorOutput: string[] = [];
  console.error = (msg: string) => {
    errorOutput.push(msg);
  };

  // 80 chars is over the 64-char cap and triggers the warning.
  const oversized = 'a'.repeat(80);
  const originalExit = process.exit;
  process.exit = (() => {}) as unknown as typeof process.exit;

  // Write a tiny input file so the CLI has something to scrub.
  const tmpFile = path.join(__dirname, '.tmp-codetell-warning.txt');
  fs.writeFileSync(tmpFile, 'plain text with no detector matches', 'utf8');

  try {
    await program.parseAsync(['node', 'test', 'scrub', tmpFile, '--code-tell-terms', oversized]);
  } finally {
    process.exit = originalExit;
    console.error = originalError;
    fs.rmSync(tmpFile, { force: true });
  }

  const combined = errorOutput.join('\n');
  t.true(
    combined.includes('CodeTellDetector dropped 1 term(s) longer than 64 chars'),
    `expected oversized-term warning, got: ${combined}`,
  );
});

test('scrub warns on stderr when more than 64 CodeTell terms are configured', async (t) => {
  const program = new Command();
  setupScrubCommand(program);

  const originalError = console.error;
  const errorOutput: string[] = [];
  console.error = (msg: string) => {
    errorOutput.push(msg);
  };

  // 80 short terms pushes 16 past the 64-term cap.
  const terms = Array.from({ length: 80 }, (_, i) => `t${i}`);
  const originalExit = process.exit;
  process.exit = (() => {}) as unknown as typeof process.exit;

  const tmpFile = path.join(__dirname, '.tmp-codetell-overflow.txt');
  fs.writeFileSync(tmpFile, 'plain text with no detector matches', 'utf8');

  try {
    await program.parseAsync([
      'node',
      'test',
      'scrub',
      tmpFile,
      '--code-tell-terms',
      terms.join(','),
    ]);
  } finally {
    process.exit = originalExit;
    console.error = originalError;
    fs.rmSync(tmpFile, { force: true });
  }

  const combined = errorOutput.join('\n');
  t.true(
    combined.includes('CodeTellDetector dropped 16 term(s) past the 64-term cap'),
    `expected overflow warning, got: ${combined}`,
  );
});
