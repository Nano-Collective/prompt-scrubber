import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'ava';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliEntry = path.resolve(__dirname, '../../src/cli/index.ts');
const tmpConfigDir = path.join(__dirname, '.tmp-config-e2e');

function runCli(args: string[], input?: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', cliEntry, ...args], {
    input,
    encoding: 'utf-8',
    env: {
      ...process.env,
      // Force the CLI to use the local temp folder. PROMPT_SCRUB_CONFIG_DIR
      // is honored on every platform; XDG_CONFIG_HOME only works on Linux.
      PROMPT_SCRUB_CONFIG_DIR: path.join(tmpConfigDir, 'prompt-scrub'),
    },
  });
}

test.before(() => {
  if (fs.existsSync(tmpConfigDir)) {
    fs.rmSync(tmpConfigDir, { recursive: true, force: true });
  }
});

test.after.always(() => {
  if (fs.existsSync(tmpConfigDir)) {
    fs.rmSync(tmpConfigDir, { recursive: true, force: true });
  }
});

test.serial('CLI: scrub reads from stdin and outputs to stdout/stderr', (t) => {
  const result = runCli(['scrub'], 'Contact me at alice@example.com');
  t.is(result.status, 0);
  t.is(result.stdout, 'Contact me at «Email_1»');
  t.regex(result.stderr, /Session ID: \w+/);
});

test.serial('CLI: scrub prints an entity summary to stderr', (t) => {
  const result = runCli(['scrub'], 'Mail alice@example.com about sk-abcdefghijklmnopqrstuvwxyz');
  t.is(result.status, 0);
  t.true(result.stderr.includes('Scrubbed: 2 entities (1 Email, 1 Secret)'));
  t.false(result.stdout.includes('Scrubbed:'));
});

test.serial('CLI: scrub reports zero entities when nothing is detected', (t) => {
  const result = runCli(['scrub'], 'nothing sensitive here');
  t.is(result.status, 0);
  t.is(result.stdout, 'nothing sensitive here');
  t.true(result.stderr.includes('Scrubbed: 0 entities'));
  t.false(result.stderr.includes('Session ID'));
});

test.serial('CLI: scrub --quiet suppresses the summary but keeps the session ID', (t) => {
  const result = runCli(['scrub', '--quiet'], 'Contact me at alice@example.com');
  t.is(result.status, 0);
  t.is(result.stdout, 'Contact me at «Email_1»');
  t.false(result.stderr.includes('Scrubbed:'));
  t.regex(result.stderr, /Session ID: \S+/);
});

test.serial('CLI: scrub -q is the short form of --quiet', (t) => {
  const result = runCli(['scrub', '-q'], 'Contact me at alice@example.com');
  t.is(result.status, 0);
  t.false(result.stderr.includes('Scrubbed:'));
});

test.serial('CLI: rehydrate reads from stdin and restores', (t) => {
  // Step 1: scrub
  const scrubRes = runCli(['scrub'], 'Secret: sk-abcdefghijklmnopqrstuvwxyz');
  const sessionIdMatch = scrubRes.stderr.match(/Session ID: (\S+)/);
  t.truthy(sessionIdMatch);
  const sessionId = sessionIdMatch![1]!;

  // Step 2: rehydrate
  const rehydrateRes = runCli(['rehydrate', '--session-id', sessionId], 'Secret: «Secret_1»');
  t.is(rehydrateRes.status, 0);
  t.is(rehydrateRes.stdout, 'Secret: sk-abcdefghijklmnopqrstuvwxyz');
});

test.serial('CLI: inspect does a dry run and prints hash', (t) => {
  const result = runCli(['inspect'], 'Check alice@example.com');
  t.is(result.status, 0);
  t.true(result.stdout.includes('alice@example.com'));
  t.true(result.stdout.includes('«Email_1»'));
  t.true(result.stdout.includes('No session written'));
  t.true(result.stdout.includes('Hash: '));
});

test.serial('CLI: inspect --hash prints only the hash', (t) => {
  const result = runCli(['inspect', '--hash'], 'Check alice@example.com');
  t.is(result.status, 0);
  t.false(result.stdout.includes('alice@example.com'));
  t.false(result.stdout.includes('«Email_1»'));
  t.false(result.stdout.includes('No session written'));
  t.regex(result.stdout.trim(), /^[a-f0-9]{64}$/i);
});

test.serial('CLI: rehydrate emits warning to stderr for hallucinated placeholder', (t) => {
  const scrubRes = runCli(['scrub'], 'My secret is sk-1234567890abcdefghijklmno');
  const sessionIdMatch = scrubRes.stderr.match(/Session ID: (\S+)/);
  const sessionId = sessionIdMatch![1]!;

  const rehydrateRes = runCli(
    ['rehydrate', '--session-id', sessionId],
    'My secret is «Secret_1» and «Secret_99»',
  );
  t.is(rehydrateRes.status, 0);
  t.is(rehydrateRes.stdout, 'My secret is sk-1234567890abcdefghijklmno and «Secret_99»');
  t.true(rehydrateRes.stderr.includes('«Secret_99»'));
});

test.serial('CLI: sessions list shows empty state', (t) => {
  // Clear the dir first for this test to ensure empty state
  const sessionsDir = path.join(tmpConfigDir, 'prompt-scrub', 'sessions');
  if (fs.existsSync(sessionsDir)) {
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  }
  const result = runCli(['sessions', 'list']);
  t.is(result.status, 0);
  t.true(result.stdout.includes('No saved sessions.'));
});

test.serial('CLI: sessions commands manage state', (t) => {
  // Setup: create a session
  const scrubRes = runCli(['scrub'], 'Contact me at alice@example.com');
  const sessionIdMatch = scrubRes.stderr.match(/Session ID: (\S+)/);
  const sessionId = sessionIdMatch![1]!;

  // List
  const listRes = runCli(['sessions', 'list']);
  t.is(listRes.status, 0);
  t.true(listRes.stdout.includes(sessionId));
  t.true(listRes.stdout.includes('1')); // placeholder count

  // Show
  const showRes = runCli(['sessions', 'show', sessionId]);
  t.is(showRes.status, 0);
  t.true(showRes.stdout.includes('alice@example.com'));

  // Rm
  const rmRes = runCli(['sessions', 'rm', sessionId]);
  t.is(rmRes.status, 0);
  t.true(rmRes.stdout.includes('deleted'));

  // Verify it's gone
  const showGoneRes = runCli(['sessions', 'show', sessionId]);
  t.not(showGoneRes.status, 0);
  t.true(showGoneRes.stderr.includes('not found'));
});

test.serial('CLI: scrub fails when input file does not exist', (t) => {
  const result = runCli(['scrub', 'non-existent-file-123.txt']);
  t.not(result.status, 0);
  t.true(result.stderr.includes('Error reading file') && result.stderr.includes('ENOENT'));
});

test.serial('CLI: scrub fails when reading from stdin with no input provided', (t) => {
  // Pass an empty string as input
  const result = runCli(['scrub'], '');
  t.is(result.status, 0); // Actually scrub.ts says process.exit(0) if !input
  t.is(result.stdout, '');
});

test.serial('CLI: sessions show fails with invalid session id', (t) => {
  const result = runCli(['sessions', 'show', 'invalid-id-xyz']);
  t.not(result.status, 0);
  t.true(result.stderr.includes('not found'));
});

test.serial('CLI: sessions rm --all handles empty sessions gracefully', (t) => {
  // Clear the dir first
  const sessionsDir = path.join(tmpConfigDir, 'prompt-scrub', 'sessions');
  if (fs.existsSync(sessionsDir)) {
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  }
  const result = runCli(['sessions', 'rm', '--all']);
  t.is(result.status, 0);
  t.true(result.stdout.includes('No sessions to remove.'));
});

test.serial('CLI: sessions rm --all successfully removes multiple sessions', (t) => {
  runCli(['scrub'], 'Contact alice@example.com');
  runCli(['scrub'], 'Contact bob@example.com');

  const result = runCli(['sessions', 'rm', '--all']);
  t.is(result.status, 0);
  t.true(result.stdout.includes('Deleted 2 sessions.'));
});
test.serial('CLI: sessions gc garbage collects expired sessions', (t) => {
  // Clear the dir first
  const sessionsDir = path.join(tmpConfigDir, 'prompt-scrub', 'sessions');
  if (fs.existsSync(sessionsDir)) {
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  }

  // Create two sessions
  const scrub1 = runCli(['scrub'], 'Contact old@example.com');
  const scrub2 = runCli(['scrub'], 'Contact new@example.com');

  const id1 = scrub1.stderr.match(/Session ID: ([\w-]+)/)?.[1];
  const id2 = scrub2.stderr.match(/Session ID: ([\w-]+)/)?.[1];

  if (!id1 || !id2) return t.fail('Failed to extract session IDs');

  // Age the first session by 10 days
  const oldPath = path.join(sessionsDir, `${id1}.json`);
  const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
  fs.utimesSync(oldPath, tenDaysAgo, tenDaysAgo);

  const result = runCli(['sessions', 'gc']);
  t.is(result.status, 0);
  t.true(result.stdout.includes('Deleted 1 expired session(s).'));

  t.false(fs.existsSync(oldPath));
  t.true(fs.existsSync(path.join(sessionsDir, `${id2}.json`)));
});

test.serial('CLI: rehydrate fails when input file does not exist', (t) => {
  const result = runCli(['rehydrate', '--session-id', 'test-id', 'non-existent-file-123.txt']);
  t.not(result.status, 0);
  t.true(result.stderr.includes('Error reading file'));
});

test.serial('CLI: rehydrate fails when reading from stdin with no input provided', (t) => {
  const result = runCli(['rehydrate', '--session-id', 'test-id'], '');
  t.is(result.status, 0);
  t.is(result.stdout, '');
});

test.serial('CLI: inspect fails when input file does not exist', (t) => {
  const result = runCli(['inspect', 'non-existent-file-123.txt']);
  t.not(result.status, 0);
  t.true(result.stderr.includes('Error reading file'));
});

test.serial('CLI: inspect fails when reading from stdin with no input provided', (t) => {
  const result = runCli(['inspect'], '');
  t.is(result.status, 0);
  t.is(result.stdout, '');
});

test.serial('CLI: sessions rm fails when session ID is missing without --all', (t) => {
  const result = runCli(['sessions', 'rm']);
  t.not(result.status, 0);
  t.true(result.stderr.includes("missing required argument 'id'"));
});

test.serial('CLI: sessions rm fails gracefully with invalid session id', (t) => {
  const result = runCli(['sessions', 'rm', 'invalid-id-xyz']);
  t.not(result.status, 0);
  t.true(result.stderr.includes('not found'));
});

test('CLI: inspect prints the confidence and method of each entity', (t) => {
  const result = runCli(['inspect'], 'Contact me at alice@example.com');
  t.is(result.status, 0);
  t.true(result.stdout.includes('confidence 0.95 exact-pattern'));
});

test('CLI: inspect --min-confidence hides findings below the threshold', (t) => {
  const input = 'Call 555-123-4567 or mail alice@example.com';

  const all = runCli(['inspect'], input);
  t.true(all.stdout.includes('[Phone]'));
  t.true(all.stdout.includes('[Email]'));

  const filtered = runCli(['inspect', '--min-confidence', '0.9'], input);
  t.is(filtered.status, 0);
  const [detected, suppressed] = filtered.stdout.split('Suppressed below');
  // The phone drops out of what would be scrubbed...
  t.false(detected?.includes('[Phone]'));
  t.true(detected?.includes('[Email]'));
  // ...and is named as still being in the clear rather than vanishing.
  t.true(suppressed?.includes('[Phone]'));
});

test('CLI: scrub --min-confidence says what it suppressed', (t) => {
  // The exact command from the review.
  const result = runCli(
    ['scrub', '--min-confidence', '0.9'],
    'mail alice@example.com and call 555-123-4567',
  );

  t.is(result.status, 0);
  t.is(result.stdout, 'mail «Email_1» and call 555-123-4567');
  t.true(
    result.stderr.includes(
      'Scrubbed: 1 entity (1 Email); 1 suppressed below --min-confidence 0.9 (1 Phone)',
    ),
  );
});

test('CLI: a run where the threshold drops everything still says so', (t) => {
  // stdout is byte-identical to a prompt with nothing sensitive in it, so the
  // summary is the only thing standing between the user and a silent leak.
  const result = runCli(['scrub', '--min-confidence', '0.95'], 'call 555-123-4567');

  t.is(result.status, 0);
  t.is(result.stdout, 'call 555-123-4567');
  t.true(
    result.stderr.includes(
      'Scrubbed: 0 entities; 1 suppressed below --min-confidence 0.95 (1 Phone)',
    ),
  );
});

test('CLI: the summary is unchanged without a threshold', (t) => {
  const result = runCli(['scrub'], 'mail alice@example.com and call 555-123-4567');

  t.is(result.status, 0);
  t.true(result.stderr.includes('Scrubbed: 2 entities (1 Email, 1 Phone)'));
  t.false(result.stderr.includes('suppressed'));
});

test('CLI: -q suppresses the summary, threshold or not', (t) => {
  const result = runCli(['scrub', '-q', '--min-confidence', '0.9'], 'call 555-123-4567');

  t.is(result.status, 0);
  t.false(result.stderr.includes('suppressed'));
});

test('CLI: --min-confidence rejects a value outside the 0-1 range', (t) => {
  const result = runCli(['scrub', '--min-confidence', '2'], 'mail alice@example.com');
  t.is(result.status, 1);
  t.true(result.stderr.includes('Expected a number between 0 and 1.'));
});

test('CLI: --min-confidence rejects trailing garbage rather than truncating it', (t) => {
  // parseFloat would read this as 0.9 and scrub at a threshold the user never
  // typed. Failing loudly is the only safe reading.
  const result = runCli(['scrub', '--min-confidence', '0.9zzz'], 'mail alice@example.com');
  t.is(result.status, 1);
  t.true(result.stderr.includes('Expected a number between 0 and 1.'));
});

test('CLI: scrub --min-confidence changes the inspect hash to match', (t) => {
  const input = 'Call 555-123-4567 or mail alice@example.com';
  const scrubbed = runCli(['scrub', '--min-confidence', '0.9'], input);
  const hash = runCli(['inspect', '--min-confidence', '0.9', '--hash'], input);

  t.is(scrubbed.stdout, 'Call 555-123-4567 or mail «Email_1»');
  t.is(hash.stdout.trim().length, 64);
  t.not(hash.stdout.trim(), runCli(['inspect', '--hash'], input).stdout.trim());
});
