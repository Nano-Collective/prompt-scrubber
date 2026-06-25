import test from 'ava';
import { spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliEntry = path.resolve(__dirname, '../../src/cli/index.ts');
const tmpConfigDir = path.join(__dirname, '.tmp-config-e2e');

function runCli(args: string[], input?: string) {
  return spawnSync('npx', ['tsx', cliEntry, ...args], {
    input,
    encoding: 'utf-8',
    env: {
      ...process.env,
      XDG_CONFIG_HOME: tmpConfigDir,
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

test('CLI: scrub reads from stdin and outputs to stdout/stderr', (t) => {
  const result = runCli(['scrub'], 'Contact me at alice@example.com');
  t.is(result.status, 0);
  t.is(result.stdout, 'Contact me at Email_1');
  t.regex(result.stderr, /Session ID: \w+/);
});

test('CLI: rehydrate reads from stdin and restores', (t) => {
  // Step 1: scrub
  const scrubRes = runCli(['scrub'], 'Secret: sk-abcdefghijklmnopqrstuvwxyz');
  const sessionIdMatch = scrubRes.stderr.match(/Session ID: (\S+)/);
  t.truthy(sessionIdMatch);
  const sessionId = sessionIdMatch![1]!;

  // Step 2: rehydrate
  const rehydrateRes = runCli(['rehydrate', '--session-id', sessionId], 'Secret: Secret_1');
  t.is(rehydrateRes.status, 0);
  t.is(rehydrateRes.stdout, 'Secret: sk-abcdefghijklmnopqrstuvwxyz');
});

test('CLI: inspect does a dry run', (t) => {
  const result = runCli(['inspect'], 'Check alice@example.com');
  t.is(result.status, 0);
  t.true(result.stdout.includes('alice@example.com'));
  t.true(result.stdout.includes('Email_1'));
  t.true(result.stdout.includes('No session written'));
});

test('CLI: rehydrate emits warning to stderr for hallucinated placeholder', (t) => {
  const scrubRes = runCli(['scrub'], 'My secret is sk-1234567890abcdefghijklmno');
  const sessionIdMatch = scrubRes.stderr.match(/Session ID: (\S+)/);
  const sessionId = sessionIdMatch![1]!;

  const rehydrateRes = runCli(
    ['rehydrate', '--session-id', sessionId],
    'My secret is Secret_1 and Secret_99',
  );
  t.is(rehydrateRes.status, 0);
  t.is(rehydrateRes.stdout, 'My secret is sk-1234567890abcdefghijklmno and Secret_99');
  t.true(rehydrateRes.stderr.includes('Secret_99'));
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

test('CLI: sessions commands manage state', (t) => {
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
