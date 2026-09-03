import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'ava';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliEntry = path.resolve(__dirname, '../../src/cli/index.ts');
const tmpConfigDir = path.join(__dirname, '.tmp-config-cli-encryption');

function runCli(args: string[], input?: string, extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, ['--import', 'tsx', cliEntry, ...args], {
    input,
    encoding: 'utf-8',
    env: {
      ...process.env,
      PROMPT_SCRUB_CONFIG_DIR: path.join(tmpConfigDir, 'prompt-scrub'),
      ...extraEnv,
    },
  });
}

function writeConfig(patch: Record<string, unknown>) {
  const configDir = path.join(tmpConfigDir, 'prompt-scrub');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(patch));
}

function listSessionIds(): string[] {
  const sessionsDir = path.join(tmpConfigDir, 'prompt-scrub', 'sessions');
  if (!fs.existsSync(sessionsDir)) return [];
  return fs
    .readdirSync(sessionsDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''));
}

test.before(() => {
  if (fs.existsSync(tmpConfigDir)) {
    fs.rmSync(tmpConfigDir, { recursive: true, force: true });
  }
  fs.mkdirSync(tmpConfigDir, { recursive: true });
});

test.after.always(() => {
  if (fs.existsSync(tmpConfigDir)) {
    fs.rmSync(tmpConfigDir, { recursive: true, force: true });
  }
});

test.serial('CLI: scrub writes encrypted sessions when encryptionEnabled is on', (t) => {
  // Reset directory so previous test state doesn't leak in.
  fs.rmSync(tmpConfigDir, { recursive: true, force: true });
  fs.mkdirSync(tmpConfigDir, { recursive: true });
  writeConfig({ encryptionEnabled: true });

  const result = runCli(['scrub'], 'My key is sk-1234567890abcdefghijklmno', {
    PROMPT_SCRUB_KEY: 'my-passphrase',
  });
  t.is(result.status, 0);
  t.is(result.stdout, 'My key is «Secret_1»');

  const sessionId = listSessionIds()[0];
  t.truthy(sessionId, 'session file must exist');

  const raw = fs.readFileSync(
    path.join(tmpConfigDir, 'prompt-scrub', 'sessions', `${sessionId}.json`),
    'utf-8',
  );
  t.false(raw.includes('sk-1234567890abcdefghijklmno'), 'plaintext must not be on disk');
  const parsed = JSON.parse(raw);
  t.is(parsed.encrypted, true);
});

test.serial('CLI: rehydrate with the wrong key exits non-zero with a clean message', (t) => {
  fs.rmSync(tmpConfigDir, { recursive: true, force: true });
  fs.mkdirSync(tmpConfigDir, { recursive: true });
  writeConfig({ encryptionEnabled: true });

  // First, create an encrypted session with a known key.
  const scrub = runCli(['scrub'], 'My email is alice@example.com', {
    PROMPT_SCRUB_KEY: 'right-key',
  });
  t.is(scrub.status, 0);
  const sessionId = listSessionIds()[0];
  t.truthy(sessionId);

  // Now try to rehydrate with a deliberately wrong key.
  const rehydrate = runCli(['rehydrate', '--session-id', sessionId], 'My email is «Email_1»', {
    PROMPT_SCRUB_KEY: 'wrong-key',
  });
  t.not(rehydrate.status, 0);
  t.true(rehydrate.stderr.includes('Unable to decrypt session'));
});

test.serial('CLI: rehydrate with no PROMPT_SCRUB_KEY and no TTY exits cleanly', (t) => {
  fs.rmSync(tmpConfigDir, { recursive: true, force: true });
  fs.mkdirSync(tmpConfigDir, { recursive: true });
  writeConfig({ encryptionEnabled: true });

  runCli(['scrub'], 'My email is alice@example.com', {
    PROMPT_SCRUB_KEY: 'real-key',
  });
  const sessionId = listSessionIds()[0];
  t.truthy(sessionId);

  // Drop the env var so the resolver would need to prompt. spawnSync gives
  // us a non-TTY stdin by default, so the prompt must fail gracefully.
  const rehydrate = runCli(['rehydrate', '--session-id', sessionId], 'My email is «Email_1»', {});
  t.not(rehydrate.status, 0);
  t.true(
    rehydrate.stderr.includes('PROMPT_SCRUB_KEY') ||
      rehydrate.stderr.includes('no PROMPT_SCRUB_KEY'),
    `expected missing-key error, got: ${rehydrate.stderr}`,
  );
});

test.serial('CLI: sessions encrypt migrates plaintext sessions to encrypted', (t) => {
  fs.rmSync(tmpConfigDir, { recursive: true, force: true });
  fs.mkdirSync(tmpConfigDir, { recursive: true });
  // First create a session with encryption OFF, then turn it ON.
  runCli(['scrub'], 'Send mail to bob@example.com', {});
  const sessionId = listSessionIds()[0];
  t.truthy(sessionId);

  const plaintextPath = path.join(tmpConfigDir, 'prompt-scrub', 'sessions', `${sessionId}.json`);
  t.true(fs.readFileSync(plaintextPath, 'utf-8').includes('bob@example.com'));

  writeConfig({ encryptionEnabled: true });

  const migrate = runCli(['sessions', 'encrypt'], undefined, { PROMPT_SCRUB_KEY: 'migrate-key' });
  t.is(migrate.status, 0, `migrate failed: ${migrate.stderr}`);
  t.true(migrate.stdout.includes('Encrypted 1 session'));

  const after = fs.readFileSync(plaintextPath, 'utf-8');
  t.false(after.includes('bob@example.com'), 'plaintext must be gone after migration');
  const parsed = JSON.parse(after);
  t.is(parsed.encrypted, true);

  // Now run encrypt again to cover the "already encrypted" (skipped) branch
  const migrateAgain = runCli(['sessions', 'encrypt'], undefined, { PROMPT_SCRUB_KEY: 'migrate-key' });
  t.is(migrateAgain.status, 0);
  t.true(migrateAgain.stdout.includes('0 session(s), 1 already encrypted'));
});

test.serial('CLI: sessions encrypt handles empty sessions list gracefully', (t) => {
  fs.rmSync(tmpConfigDir, { recursive: true, force: true });
  fs.mkdirSync(tmpConfigDir, { recursive: true });
  writeConfig({ encryptionEnabled: true });

  const result = runCli(['sessions', 'encrypt'], undefined, { PROMPT_SCRUB_KEY: 'k' });
  t.is(result.status, 0);
  t.true(result.stdout.includes('No sessions to encrypt.'));
});

test.serial('CLI: sessions encrypt requires encryptionEnabled', (t) => {
  fs.rmSync(tmpConfigDir, { recursive: true, force: true });
  fs.mkdirSync(tmpConfigDir, { recursive: true });
  // No config file at all — encryptionEnabled defaults to false.

  const result = runCli(['sessions', 'encrypt'], undefined, { PROMPT_SCRUB_KEY: 'k' });
  t.not(result.status, 0);
  t.true(result.stderr.includes('encryption is not enabled'));
});

test.serial('CLI: sessions list handles encrypted sessions without leaking plaintext', (t) => {
  fs.rmSync(tmpConfigDir, { recursive: true, force: true });
  fs.mkdirSync(tmpConfigDir, { recursive: true });
  writeConfig({ encryptionEnabled: true });

  runCli(['scrub'], 'My phone is +1-555-123-4567', { PROMPT_SCRUB_KEY: 'list-key' });

  const list = runCli(['sessions', 'list'], undefined, { PROMPT_SCRUB_KEY: 'list-key' });
  t.is(list.status, 0);
  t.false(list.stdout.includes('+1-555-123-4567'), 'plaintext must not appear in CLI output');
});

test.serial('CLI: scrub with encryption off after encryption was on does not downgrade', (t) => {
  fs.rmSync(tmpConfigDir, { recursive: true, force: true });
  fs.mkdirSync(tmpConfigDir, { recursive: true });
  writeConfig({ encryptionEnabled: true });

  const secret = 'sk-1234567890abcdefghijklmnopqrstuvwxyz';
  const scrub1 = runCli(['scrub'], `My key is ${secret}`, {
    PROMPT_SCRUB_KEY: 'persist-key',
  });
  t.is(scrub1.status, 0, `first scrub failed: status=${scrub1.status} stderr=${scrub1.stderr}`);
  const sessionId = listSessionIds()[0];
  t.truthy(
    sessionId,
    `no session file was written: stdout=${scrub1.stdout} stderr=${scrub1.stderr}`,
  );

  // Flip encryption off and rewrite the session through the CLI by running
  // scrub with --session-id of the same id; this should keep encryption on.
  writeConfig({ encryptionEnabled: false });
  runCli(['scrub', '--session-id', sessionId], `My key is ${secret}`, {
    PROMPT_SCRUB_KEY: 'persist-key',
  });

  const raw = fs.readFileSync(
    path.join(tmpConfigDir, 'prompt-scrub', 'sessions', `${sessionId}.json`),
    'utf-8',
  );
  t.true(raw.includes('"encrypted": true'), 'session must stay encrypted across the toggle');
});
