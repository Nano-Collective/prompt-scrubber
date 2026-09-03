import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'ava';
import { Command } from 'commander';
import { setupSessionsCommands } from '../../src/cli/commands/sessions.js';
import { deleteSessionMap, readSessionMap, writeSessionMap } from '../../src/session/storage.js';
import { clearCachedEncryptionKey, setCachedEncryptionKey } from '../../src/core/key-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const tmpConfigDir = path.join(__dirname, '.tmp-config-cli-sessions');

test.before(() => {
  process.env.PROMPT_SCRUB_CONFIG_DIR = path.join(tmpConfigDir, 'prompt-scrub');
  if (fs.existsSync(tmpConfigDir)) {
    fs.rmSync(tmpConfigDir, { recursive: true, force: true });
  }
});

test.after.always(() => {
  if (fs.existsSync(tmpConfigDir)) {
    fs.rmSync(tmpConfigDir, { recursive: true, force: true });
  }
  clearCachedEncryptionKey();
  delete process.env.PROMPT_SCRUB_KEY;
});

test.serial('sessions rm command fails when session does not exist', async (t) => {
  const program = new Command();
  setupSessionsCommands(program);

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

  // Attempting to remove a session that definitely doesn't exist
  await program.parseAsync(['node', 'test', 'sessions', 'rm', 'this-session-does-not-exist-999']);

  process.exit = originalExit;
  console.error = originalError;

  t.is(exitCode, 1);
  t.true(errorOutput.includes('not found'));
});

test.serial('sessions encrypt exits non-zero when encryptionEnabled is false', async (t) => {
  // Make sure no config file exists so encryptionEnabled defaults to off.
  const configPath = path.join(tmpConfigDir, 'prompt-scrub', 'config.json');
  if (fs.existsSync(configPath)) fs.rmSync(configPath);

  const program = new Command();
  setupSessionsCommands(program);

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

  // The resolver would normally need a key, but it should never get that
  // far because encryption is disabled — we expect an early exit.
  await program.parseAsync(['node', 'test', 'sessions', 'encrypt']);

  process.exit = originalExit;
  console.error = originalError;

  t.is(exitCode, 1);
  t.true(errorOutput.includes('encryption is not enabled'));
});

test.serial('sessions encrypt migrates plaintext to encrypted on disk', async (t) => {
  // Write a config with encryptionEnabled, then plant a plaintext session.
  const configPath = path.join(tmpConfigDir, 'prompt-scrub', 'config.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({ encryptionEnabled: true }));

  // Plant a plaintext session directly (encryption off → writeSessionMap
  // would emit ciphertext otherwise, so we bypass it via raw fs).
  const sessionsDir = path.join(tmpConfigDir, 'prompt-scrub', 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionsDir, 'plaintext-to-encrypt.json'),
    JSON.stringify({ '«Email_1»': 'planted@example.com' }),
  );

  setCachedEncryptionKey('cli-encrypt-key');
  process.env.PROMPT_SCRUB_KEY = 'cli-encrypt-key';

  const program = new Command();
  setupSessionsCommands(program);

  const originalExit = process.exit;
  const originalLog = console.log;
  let exitCode: number | undefined;
  let logOutput = '';

  process.exit = ((code?: number) => {
    exitCode = code;
  }) as unknown as typeof process.exit;
  console.log = (msg: string) => {
    logOutput += msg;
  };

  await program.parseAsync(['node', 'test', 'sessions', 'encrypt', 'plaintext-to-encrypt']);

  process.exit = originalExit;
  console.log = originalLog;

  t.is(exitCode, undefined);
  t.true(logOutput.includes('Encrypted 1 session'));

  const readMap = readSessionMap('plaintext-to-encrypt');
  t.deepEqual(readMap, { '«Email_1»': 'planted@example.com' });

  // Cleanup
  clearCachedEncryptionKey();
  delete process.env.PROMPT_SCRUB_KEY;
  deleteSessionMap('plaintext-to-encrypt');
  fs.rmSync(configPath);
});

test.serial('sessions encrypt skips already-encrypted sessions', async (t) => {
  const configPath = path.join(tmpConfigDir, 'prompt-scrub', 'config.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({ encryptionEnabled: true }));

  setCachedEncryptionKey('skip-key');
  process.env.PROMPT_SCRUB_KEY = 'skip-key';
  writeSessionMap('already-encrypted', { '«Email_1»': 'skip@example.com' });

  const program = new Command();
  setupSessionsCommands(program);

  const originalExit = process.exit;
  const originalLog = console.log;
  let exitCode: number | undefined;
  let logOutput = '';

  process.exit = ((code?: number) => {
    exitCode = code;
  }) as unknown as typeof process.exit;
  console.log = (msg: string) => {
    logOutput += msg;
  };

  await program.parseAsync(['node', 'test', 'sessions', 'encrypt', 'already-encrypted']);

  process.exit = originalExit;
  console.log = originalLog;

  t.is(exitCode, undefined);
  t.true(logOutput.includes('already encrypted'));

  // Cleanup
  clearCachedEncryptionKey();
  delete process.env.PROMPT_SCRUB_KEY;
  deleteSessionMap('already-encrypted');
  fs.rmSync(configPath);
});
