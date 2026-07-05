import test from 'ava';
import { Command } from 'commander';
import { setupSessionsCommands } from '../../src/cli/commands/sessions.js';

test.serial('sessions rm command fails when session does not exist', async (t) => {
  const program = new Command();
  setupSessionsCommands(program);

  const originalExit = process.exit;
  const originalError = console.error;
  let exitCode: number | undefined;
  let errorOutput = '';

  process.exit = ((code?: number) => {
    exitCode = code;
  }) as any;
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
