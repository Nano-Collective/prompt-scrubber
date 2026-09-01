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
  // Forms Number() handles that parseFloat also handled — no regression.
  t.is(parseConfidence('.85'), 0.85);
  t.is(parseConfidence('9e-1'), 0.9);
  t.is(parseConfidence(' 0.5 '), 0.5);

  // '0.9zzz' is the important one: parseFloat stops at the first invalid
  // character and would silently run at 0.9, which is exactly the quiet
  // reinterpretation this parser exists to prevent.
  for (const bad of ['-0.1', '1.1', 'high', '', '0.9zzz', '0.5 0.6', 'NaN', 'Infinity']) {
    t.throws(() => parseConfidence(bad), { message: 'Expected a number between 0 and 1.' });
  }
});

test('formatScrubSummary reports what a threshold suppressed', (t) => {
  // The dangerous case: nothing was scrubbed, but something WAS found and
  // dropped. Without the second clause this is indistinguishable from a clean
  // prompt.
  t.is(
    formatScrubSummary(
      { totalEntities: 0, byCategory: {}, suppressed: { total: 1, byCategory: { Phone: 1 } } },
      0.95,
    ),
    'Scrubbed: 0 entities; 1 suppressed below --min-confidence 0.95 (1 Phone)',
  );

  // The example from the review, verbatim.
  t.is(
    formatScrubSummary(
      {
        totalEntities: 1,
        byCategory: { Email: 1 },
        suppressed: { total: 1, byCategory: { Phone: 1 } },
      },
      0.9,
    ),
    'Scrubbed: 1 entity (1 Email); 1 suppressed below --min-confidence 0.9 (1 Phone)',
  );

  // Plurals apply to the suppressed breakdown too.
  t.is(
    formatScrubSummary(
      {
        totalEntities: 1,
        byCategory: { Email: 1 },
        suppressed: { total: 3, byCategory: { Phone: 2, Address: 1 } },
      },
      0.9,
    ),
    'Scrubbed: 1 entity (1 Email); 3 suppressed below --min-confidence 0.9 (2 Phones, 1 Address)',
  );
});

test('formatScrubSummary is unchanged when nothing was suppressed', (t) => {
  // No threshold in play, and a threshold that cost nothing, both produce the
  // exact string the tool printed before this feature existed.
  t.is(
    formatScrubSummary({ totalEntities: 1, byCategory: { Email: 1 } }),
    'Scrubbed: 1 entity (1 Email)',
  );
  t.is(
    formatScrubSummary({ totalEntities: 1, byCategory: { Email: 1 } }, 0.9),
    'Scrubbed: 1 entity (1 Email)',
  );
  t.is(
    formatScrubSummary(
      { totalEntities: 1, byCategory: { Email: 1 }, suppressed: { total: 0, byCategory: {} } },
      0.9,
    ),
    'Scrubbed: 1 entity (1 Email)',
  );
});

test('handleScrub reports the phone the threshold dropped', async (t) => {
  // The exact command from the review.
  const result = await handleScrub('mail alice@example.com and call 555-123-4567', {
    minConfidence: 0.9,
  });

  t.is(result.scrubbedContent, 'mail «Email_1» and call 555-123-4567');
  t.is(result.minConfidence, 0.9);
  t.is(
    formatScrubSummary(result.stats, result.minConfidence),
    'Scrubbed: 1 entity (1 Email); 1 suppressed below --min-confidence 0.9 (1 Phone)',
  );
});

test('handleScrub reports suppression even when nothing survived', async (t) => {
  const result = await handleScrub('call 555-123-4567', { minConfidence: 0.95 });

  t.is(result.scrubbedContent, 'call 555-123-4567');
  t.is(
    formatScrubSummary(result.stats, result.minConfidence),
    'Scrubbed: 0 entities; 1 suppressed below --min-confidence 0.95 (1 Phone)',
  );
});

test('handleScrub leaves stats.suppressed absent without a threshold', async (t) => {
  const result = await handleScrub('mail alice@example.com and call 555-123-4567', {});

  t.is(result.stats.suppressed, undefined);
  t.is(
    formatScrubSummary(result.stats, result.minConfidence),
    'Scrubbed: 2 entities (1 Email, 1 Phone)',
  );
});
