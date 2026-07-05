import test from 'ava';
import { handleScrub } from '../../src/cli/commands/scrub.js';

test('handleScrub processes text and returns result', async (t) => {
  const result = await handleScrub('My email is test@example.com', {});
  t.is(result.scrubbedContent, 'My email is Email_1');
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
  t.is(result.scrubbedContent, 'say hello to Name_1.');
});

test('handleScrub respects strictName option', async (t) => {
  const result = await handleScrub('Hello John.', {
    enable: 'NameDetector',
    strictName: true,
  });
  // 'John' is in the allowlist, so it should not be scrubbed in strict mode
  t.is(result.scrubbedContent, 'Hello John.');
});

test('handleScrub respects codeTellTerms', async (t) => {
  const result = await handleScrub('const myVar = 1;', {
    codeTellTerms: 'myVar, otherVar',
  });
  t.is(result.scrubbedContent, 'const CodeTell_1 = 1;');
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
  }) as any;
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
  }) as any;
  console.error = (msg: string) => {
    errorOutput += msg;
  };

  await program.parseAsync(['node', 'test', 'scrub']);

  process.exit = originalExit;
  console.error = originalError;

  t.is(exitCode, 1);
  t.true(errorOutput.includes('No input provided'));
});
