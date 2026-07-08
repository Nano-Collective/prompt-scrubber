import test from 'ava';
import { handleRehydrate } from '../../src/cli/commands/rehydrate.js';
import { writeSessionMap } from '../../src/session/storage.js';

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
