import test from 'ava';
import { spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliEntry = path.resolve(__dirname, '../../src/cli/index.ts');

function runCli(args: string[], input?: string) {
  return spawnSync('npx', ['tsx', cliEntry, ...args], {
    input,
    encoding: 'utf-8',
    env: {
      ...process.env,
      XDG_CONFIG_HOME: path.join(__dirname, '.tmp-config-e2e'),
    },
  });
}

test.before(() => {
  const tmpConfigDir = path.join(__dirname, '.tmp-config-e2e');
  if (fs.existsSync(tmpConfigDir)) {
    fs.rmSync(tmpConfigDir, { recursive: true, force: true });
  }
});

test.after.always(() => {
  const tmpConfigDir = path.join(__dirname, '.tmp-config-e2e');
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
  const rehydrateRes = runCli(
    ['rehydrate', '--session-id', sessionId],
    'Secret: Secret_1',
  );
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
