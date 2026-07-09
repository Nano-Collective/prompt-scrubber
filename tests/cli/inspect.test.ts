import test from 'ava';
import { computeHash, formatInspectOutput, handleInspect } from '../../src/cli/commands/inspect.js';

test('handleInspect finds entities without side effects', async (t) => {
  const findings = await handleInspect('My email is test@example.com', {});
  t.is(findings.length, 1);
  t.is(findings[0]?.category, 'Email');
});

test('formatInspectOutput formats findings and includes hash', async (t) => {
  const findings = await handleInspect('My email is test@example.com', {});
  const hash = computeHash('My email is test@example.com', findings);
  const output = formatInspectOutput(findings, hash);
  t.true(output.includes('test@example.com'));
  t.true(output.includes('«Email_1»'));
  t.true(output.includes(`Hash: ${hash}`));
});

test('formatInspectOutput handles empty findings and includes hash', (t) => {
  const hash = computeHash('Hello', []);
  const output = formatInspectOutput([], hash);
  t.true(output.includes('No sensitive entities detected'));
  t.true(output.includes(`Hash: ${hash}`));
});

test('computeHash yields identical hash for identical scrubbed output (byte stability)', async (t) => {
  const text = 'My email is test@example.com';
  const findings = await handleInspect(text, {});
  const hash1 = computeHash(text, findings);
  const hash2 = computeHash(text, findings);
  t.is(hash1, hash2);
});

test('computeHash yields different hashes for different scrubbed outputs', async (t) => {
  const text1 = 'My email is test@example.com';
  const findings1 = await handleInspect(text1, {});
  const hash1 = computeHash(text1, findings1);

  const text2 = 'Your email is other@example.com';
  const findings2 = await handleInspect(text2, {});
  const hash2 = computeHash(text2, findings2);

  t.not(hash1, hash2);
});

import { Command } from 'commander';
import { setupInspectCommand } from '../../src/cli/commands/inspect.js';

test.serial('inspect command fails when file is unreadable', async (t) => {
  const program = new Command();
  setupInspectCommand(program);

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

  await program.parseAsync(['node', 'test', 'inspect', 'non-existent-file-999.txt']);

  process.exit = originalExit;
  console.error = originalError;

  t.is(exitCode, 1);
  t.true(errorOutput.includes('Error reading file'));
});

test.serial('inspect command fails when no stdin is provided', async (t) => {
  const program = new Command();
  setupInspectCommand(program);

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

  // Actually, mocking fs.readFileSync doesn't work for ES modules imported elsewhere.
  // We can just pass no stdin by relying on the test environment having closed stdin,
  // or by just calling the action directly, but Commander parse works.

  await program.parseAsync(['node', 'test', 'inspect']);

  process.exit = originalExit;
  console.error = originalError;

  t.is(exitCode, 1);
  t.true(errorOutput.includes('No input provided'));
});
