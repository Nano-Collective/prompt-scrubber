import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'ava';
import { handleRehydrate } from '../../src/cli/commands/rehydrate.js';
import { writeSessionMap } from '../../src/session/storage.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const tmpConfigDir = path.join(__dirname, '.tmp-config-cli-rehydrate');

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

test('handleRehydrate restores placeholder', (t) => {
  writeSessionMap('cli-rh-test', { '«Email_1»': 'cli@example.com' });
  const result = handleRehydrate('Send to «Email_1»', { sessionId: 'cli-rh-test' });
  t.is(result.content, 'Send to cli@example.com');
});

import { Command } from 'commander';
import { setupRehydrateCommand } from '../../src/cli/commands/rehydrate.js';

test.serial('rehydrate command fails when file is unreadable', async (t) => {
  const program = new Command();
  setupRehydrateCommand(program);

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

  await program.parseAsync([
    'node',
    'test',
    'rehydrate',
    'non-existent-file-999.txt',
    '--session-id',
    'test',
  ]);

  process.exit = originalExit;
  console.error = originalError;

  t.is(exitCode, 1);
  t.true(errorOutput.includes('Error reading file'));
});

test.serial('rehydrate command fails when no stdin is provided', async (t) => {
  const program = new Command();
  setupRehydrateCommand(program);

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

  await program.parseAsync(['node', 'test', 'rehydrate', '--session-id', 'test']);

  process.exit = originalExit;
  console.error = originalError;

  t.is(exitCode, 1);
  t.true(errorOutput.includes('No input provided'));
});
