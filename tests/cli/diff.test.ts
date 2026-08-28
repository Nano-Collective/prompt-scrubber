import { Command } from 'commander';
import test from 'ava';
import { formatDiff, setupDiffCommand } from '../../src/cli/commands/diff.js';
import { handleInspect, simulateScrub } from '../../src/cli/commands/inspect.js';

test('formatDiff shows a minus/plus pair for a one-line change', (t) => {
  const out = formatDiff('Email me at alice@corp.com', 'Email me at «Email_1»', {
    color: false,
  });
  t.is(out, '- Email me at alice@corp.com\n+ Email me at «Email_1»\n');
});

test('formatDiff ignores a trailing newline so echo pipes stay one hunk', (t) => {
  const out = formatDiff('Email me at alice@corp.com\n', 'Email me at «Email_1»\n', {
    color: false,
  });
  t.is(out, '- Email me at alice@corp.com\n+ Email me at «Email_1»\n');
});

test('formatDiff reports when nothing changed', (t) => {
  t.is(formatDiff('hello', 'hello', { color: false }), 'No changes.\n');
});

test('formatDiff includes context lines around a change', (t) => {
  const original = 'alpha\nEmail me at alice@corp.com\nomega';
  const scrubbed = 'alpha\nEmail me at «Email_1»\nomega';
  const out = formatDiff(original, scrubbed, { color: false, context: 1 });
  t.is(out, '  alpha\n- Email me at alice@corp.com\n+ Email me at «Email_1»\n  omega\n');
});

test('formatDiff omits distant unchanged lines beyond context', (t) => {
  const original = 'a\nb\nc\nsecret@x.com\nd\ne\nf';
  const scrubbed = 'a\nb\nc\n«Email_1»\nd\ne\nf';
  const out = formatDiff(original, scrubbed, { color: false, context: 1 });
  t.false(out.includes('  a\n'));
  t.true(out.includes('  c\n'));
  t.true(out.includes('- secret@x.com\n'));
  t.true(out.includes('+ «Email_1»\n'));
  t.true(out.includes('  d\n'));
  t.false(out.includes('  f\n'));
});

test('formatDiff colors removed and added lines when color is on', (t) => {
  const out = formatDiff('alice@corp.com', '«Email_1»', { color: true });
  t.true(out.includes('\x1b[31m- alice@corp.com\x1b[0m'));
  t.true(out.includes('\x1b[32m+ «Email_1»\x1b[0m'));
});

test('formatDiff --side-by-side puts original and scrubbed on one row', (t) => {
  const out = formatDiff('Email me at alice@corp.com', 'Email me at «Email_1»', {
    color: false,
    sideBySide: true,
    width: 72,
  });
  t.true(out.includes('|'));
  t.true(out.includes('alice@corp.com'));
  t.true(out.includes('«Email_1»'));
  t.false(out.includes('- Email'));
});

test('simulateScrub matches what inspect would replace', async (t) => {
  const text = 'Email me at alice@corp.com';
  const findings = await handleInspect(text, {});
  t.is(simulateScrub(text, findings), 'Email me at «Email_1»');
});

test.serial('diff command fails when file is unreadable', async (t) => {
  const program = new Command();
  setupDiffCommand(program);

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

  await program.parseAsync(['node', 'test', 'diff', 'non-existent-file-999.txt']);

  process.exit = originalExit;
  console.error = originalError;

  t.is(exitCode, 1);
  t.true(errorOutput.includes('Error reading file'));
});
