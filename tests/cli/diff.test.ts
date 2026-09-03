import { Command } from 'commander';
import test from 'ava';
import { formatDiff, parseContext, setupDiffCommand } from '../../src/cli/commands/diff.js';
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

test('formatDiff --side-by-side wraps instead of dropping the tail', (t) => {
  const original = `${'prefix '.repeat(20)}unscrubbed-secret@corp.com`;
  const scrubbed = `${'prefix '.repeat(20)}«Email_1»`;
  const out = formatDiff(original, scrubbed, { color: false, sideBySide: true, width: 60 });
  t.true(out.includes('unscrubbed-secret@corp.com'));
  t.true(out.includes('«Email_1»'));
  t.false(out.includes('...'));
});

test('formatDiff strips ESC and C0 from rendered lines', (t) => {
  const out = formatDiff(`\x1b[2Jhide-me@corp.com`, '«Email_1»', { color: false });
  t.false(out.includes('\x1b'));
  t.false(out.includes('[2J'));
  t.true(out.includes('hide-me@corp.com'));
});

test('formatDiff inserts ... between non-adjacent hunks', (t) => {
  const original = 'a\nb\none@x.com\nc\nd\ne\nf\ntwo@x.com\ng';
  const scrubbed = 'a\nb\n«Email_1»\nc\nd\ne\nf\n«Email_2»\ng';
  const out = formatDiff(original, scrubbed, { color: false, context: 1 });
  t.true(out.includes('  ...\n'));
  t.true(out.includes('- one@x.com\n'));
  t.true(out.includes('- two@x.com\n'));
});

test('formatDiff handles unequal line counts', (t) => {
  const out = formatDiff('keep\nold\nline\nkeep', 'keep\nnew\nkeep', { color: false, context: 0 });
  t.true(out.includes('- old\n'));
  t.true(out.includes('- line\n'));
  t.true(out.includes('+ new\n'));
});

test('formatDiff index-pairs a long equal-length file without dropping the change', (t) => {
  const head = Array.from({ length: 2000 }, (_, i) => `line-${i}`);
  const original = [...head, 'leak@corp.com', ...head].join('\n');
  const scrubbed = [...head, '«Email_1»', ...head].join('\n');
  const out = formatDiff(original, scrubbed, { color: false, context: 0 });
  t.is(out, '- leak@corp.com\n+ «Email_1»\n');
});

test('parseContext accepts zero and rejects junk', (t) => {
  t.is(parseContext('0'), 0);
  t.is(parseContext('12'), 12);
  t.throws(() => parseContext('abc'));
  t.throws(() => parseContext('-5'));
  t.throws(() => parseContext('3.2'));
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
