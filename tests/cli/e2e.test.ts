import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'ava';
import { computeHash } from '../../src/cli/commands/inspect.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliEntry = path.resolve(__dirname, '../../src/cli/index.ts');
const tmpConfigDir = path.join(__dirname, '.tmp-config-e2e');
const tmpFilesDir = path.join(__dirname, '.tmp-files-e2e');

function runCli(args: string[], input?: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', cliEntry, ...args], {
    input,
    encoding: 'utf-8',
    env: {
      ...process.env,
      // Force the CLI to use the local temp folder. PROMPT_SCRUB_CONFIG_DIR
      // is honored on every platform; XDG_CONFIG_HOME only works on Linux.
      PROMPT_SCRUB_CONFIG_DIR: path.join(tmpConfigDir, 'prompt-scrub'),
    },
  });
}

test.before(() => {
  if (fs.existsSync(tmpConfigDir)) {
    fs.rmSync(tmpConfigDir, { recursive: true, force: true });
  }
});

test.after.always(() => {
  for (const dir of [tmpConfigDir, tmpFilesDir]) {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test.serial('CLI: scrub reads from stdin and outputs to stdout/stderr', (t) => {
  const result = runCli(['scrub'], 'Contact me at alice@example.com');
  t.is(result.status, 0);
  t.is(result.stdout, 'Contact me at «Email_1»');
  t.regex(result.stderr, /Session ID: \w+/);
});

test.serial('CLI: scrub prints an entity summary to stderr', (t) => {
  const result = runCli(['scrub'], 'Mail alice@example.com about sk-abcdefghijklmnopqrstuvwxyz');
  t.is(result.status, 0);
  t.true(result.stderr.includes('Scrubbed: 2 entities (1 Email, 1 Secret)'));
  t.false(result.stdout.includes('Scrubbed:'));
});

test.serial('CLI: scrub reports zero entities when nothing is detected', (t) => {
  const result = runCli(['scrub'], 'nothing sensitive here');
  t.is(result.status, 0);
  t.is(result.stdout, 'nothing sensitive here');
  t.true(result.stderr.includes('Scrubbed: 0 entities'));
  t.false(result.stderr.includes('Session ID'));
});

test.serial('CLI: scrub --quiet suppresses the summary but keeps the session ID', (t) => {
  const result = runCli(['scrub', '--quiet'], 'Contact me at alice@example.com');
  t.is(result.status, 0);
  t.is(result.stdout, 'Contact me at «Email_1»');
  t.false(result.stderr.includes('Scrubbed:'));
  t.regex(result.stderr, /Session ID: \S+/);
});

test.serial('CLI: scrub -q is the short form of --quiet', (t) => {
  const result = runCli(['scrub', '-q'], 'Contact me at alice@example.com');
  t.is(result.status, 0);
  t.false(result.stderr.includes('Scrubbed:'));
});

test.serial('CLI: scrub -q still reports what --min-confidence suppressed', (t) => {
  // -q is exactly the automated-workflow path --min-confidence targets, so it
  // must not be the thing that hides what got dropped — the dangerous
  // direction for a redaction tool is silent under-redaction.
  const result = runCli(
    ['scrub', '-q', '--min-confidence', '0.9'],
    'mail alice@example.com and call 555-123-4567',
  );
  t.is(result.status, 0);
  t.is(result.stdout, 'mail «Email_1» and call 555-123-4567');
  t.false(result.stderr.includes('Scrubbed:'));
  t.true(result.stderr.includes('1 suppressed below --min-confidence 0.9 (1 Phone)'));
});

test.serial('CLI: scrub -q prints nothing when there is nothing to suppress', (t) => {
  const result = runCli(['scrub', '-q', '--min-confidence', '0.9'], 'nothing sensitive here');
  t.is(result.status, 0);
  t.is(result.stdout, 'nothing sensitive here');
  t.is(result.stderr, '');
});

test.serial('CLI: rehydrate reads from stdin and restores', (t) => {
  // Step 1: scrub
  const scrubRes = runCli(['scrub'], 'Secret: sk-abcdefghijklmnopqrstuvwxyz');
  const sessionIdMatch = scrubRes.stderr.match(/Session ID: (\S+)/);
  t.truthy(sessionIdMatch);
  const sessionId = sessionIdMatch![1]!;

  // Step 2: rehydrate
  const rehydrateRes = runCli(['rehydrate', '--session-id', sessionId], 'Secret: «Secret_1»');
  t.is(rehydrateRes.status, 0);
  t.is(rehydrateRes.stdout, 'Secret: sk-abcdefghijklmnopqrstuvwxyz');
});

test.serial('CLI: inspect does a dry run and prints hash', (t) => {
  const result = runCli(['inspect'], 'Check alice@example.com');
  t.is(result.status, 0);
  t.true(result.stdout.includes('alice@example.com'));
  t.true(result.stdout.includes('«Email_1»'));
  t.true(result.stdout.includes('No session written'));
  t.true(result.stdout.includes('Hash: '));
});

test.serial('CLI: inspect --hash prints only the hash', (t) => {
  const result = runCli(['inspect', '--hash'], 'Check alice@example.com');
  t.is(result.status, 0);
  t.false(result.stdout.includes('alice@example.com'));
  t.false(result.stdout.includes('«Email_1»'));
  t.false(result.stdout.includes('No session written'));
  t.regex(result.stdout.trim(), /^[a-f0-9]{64}$/i);
});

test.serial('CLI: rehydrate emits warning to stderr for hallucinated placeholder', (t) => {
  const scrubRes = runCli(['scrub'], 'My secret is sk-1234567890abcdefghijklmno');
  const sessionIdMatch = scrubRes.stderr.match(/Session ID: (\S+)/);
  const sessionId = sessionIdMatch![1]!;

  const rehydrateRes = runCli(
    ['rehydrate', '--session-id', sessionId],
    'My secret is «Secret_1» and «Secret_99»',
  );
  t.is(rehydrateRes.status, 0);
  t.is(rehydrateRes.stdout, 'My secret is sk-1234567890abcdefghijklmno and «Secret_99»');
  t.true(rehydrateRes.stderr.includes('«Secret_99»'));
});

test.serial('CLI: sessions list shows empty state', (t) => {
  // Clear the dir first for this test to ensure empty state
  const sessionsDir = path.join(tmpConfigDir, 'prompt-scrub', 'sessions');
  if (fs.existsSync(sessionsDir)) {
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  }
  const result = runCli(['sessions', 'list']);
  t.is(result.status, 0);
  t.true(result.stdout.includes('No saved sessions.'));
});

test.serial('CLI: sessions commands manage state', (t) => {
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

test.serial('CLI: scrub fails when input file does not exist', (t) => {
  const result = runCli(['scrub', 'non-existent-file-123.txt']);
  t.not(result.status, 0);
  t.true(result.stderr.includes('Error reading file') && result.stderr.includes('ENOENT'));
});

test.serial('CLI: scrub fails when reading from stdin with no input provided', (t) => {
  // Pass an empty string as input
  const result = runCli(['scrub'], '');
  t.is(result.status, 0); // Actually scrub.ts says process.exit(0) if !input
  t.is(result.stdout, '');
});

test.serial('CLI: sessions show fails with invalid session id', (t) => {
  const result = runCli(['sessions', 'show', 'invalid-id-xyz']);
  t.not(result.status, 0);
  t.true(result.stderr.includes('not found'));
});

test.serial('CLI: sessions rm --all handles empty sessions gracefully', (t) => {
  // Clear the dir first
  const sessionsDir = path.join(tmpConfigDir, 'prompt-scrub', 'sessions');
  if (fs.existsSync(sessionsDir)) {
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  }
  const result = runCli(['sessions', 'rm', '--all']);
  t.is(result.status, 0);
  t.true(result.stdout.includes('No sessions to remove.'));
});

test.serial('CLI: sessions rm --all successfully removes multiple sessions', (t) => {
  runCli(['scrub'], 'Contact alice@example.com');
  runCli(['scrub'], 'Contact bob@example.com');

  const result = runCli(['sessions', 'rm', '--all']);
  t.is(result.status, 0);
  t.true(result.stdout.includes('Deleted 2 sessions.'));
});
test.serial('CLI: sessions gc garbage collects expired sessions', (t) => {
  // Clear the dir first
  const sessionsDir = path.join(tmpConfigDir, 'prompt-scrub', 'sessions');
  if (fs.existsSync(sessionsDir)) {
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  }

  // Create two sessions
  const scrub1 = runCli(['scrub'], 'Contact old@example.com');
  const scrub2 = runCli(['scrub'], 'Contact new@example.com');

  const id1 = scrub1.stderr.match(/Session ID: ([\w-]+)/)?.[1];
  const id2 = scrub2.stderr.match(/Session ID: ([\w-]+)/)?.[1];

  if (!id1 || !id2) return t.fail('Failed to extract session IDs');

  // Age the first session by 10 days
  const oldPath = path.join(sessionsDir, `${id1}.json`);
  const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
  fs.utimesSync(oldPath, tenDaysAgo, tenDaysAgo);

  const result = runCli(['sessions', 'gc']);
  t.is(result.status, 0);
  t.true(result.stdout.includes('Deleted 1 expired session(s).'));

  t.false(fs.existsSync(oldPath));
  t.true(fs.existsSync(path.join(sessionsDir, `${id2}.json`)));
});

test.serial('CLI: rehydrate fails when input file does not exist', (t) => {
  const result = runCli(['rehydrate', '--session-id', 'test-id', 'non-existent-file-123.txt']);
  t.not(result.status, 0);
  t.true(result.stderr.includes('Error reading file'));
});

test.serial('CLI: rehydrate fails when reading from stdin with no input provided', (t) => {
  const result = runCli(['rehydrate', '--session-id', 'test-id'], '');
  t.is(result.status, 0);
  t.is(result.stdout, '');
});

test.serial('CLI: inspect fails when input file does not exist', (t) => {
  const result = runCli(['inspect', 'non-existent-file-123.txt']);
  t.not(result.status, 0);
  t.true(result.stderr.includes('Error reading file'));
});

test.serial('CLI: inspect fails when reading from stdin with no input provided', (t) => {
  const result = runCli(['inspect'], '');
  t.is(result.status, 0);
  t.is(result.stdout, '');
});

test.serial('CLI: diff prints original vs scrubbed and writes no session', (t) => {
  const sessionsDir = path.join(tmpConfigDir, 'prompt-scrub', 'sessions');
  if (fs.existsSync(sessionsDir)) {
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  }

  const result = runCli(['diff', '--no-color'], 'Email me at alice@corp.com');
  t.is(result.status, 0);
  t.is(result.stdout, '- Email me at alice@corp.com\n+ Email me at «Email_1»\n');

  const listRes = runCli(['sessions', 'list']);
  t.true(listRes.stdout.includes('No saved sessions.'));
});

test.serial('CLI: diff --side-by-side uses a two-column layout', (t) => {
  const result = runCli(['diff', '--side-by-side', '--no-color'], 'Email me at alice@corp.com');
  t.is(result.status, 0);
  t.true(result.stdout.includes('|'));
  t.true(result.stdout.includes('alice@corp.com'));
  t.true(result.stdout.includes('«Email_1»'));
});

test.serial('CLI: help lists the diff command', (t) => {
  const result = runCli(['--help']);
  t.is(result.status, 0);
  t.true(result.stdout.includes('Show a visual diff of original vs scrubbed text'));
});

test.serial('CLI: diff rejects a non-integer --context', (t) => {
  const result = runCli(['diff', '--context', 'abc'], 'Email me at alice@corp.com');
  t.not(result.status, 0);
  t.true(result.stderr.includes('--context must be a non-negative integer'));
});

test.serial('CLI: diff reads a file path', (t) => {
  fs.mkdirSync(tmpConfigDir, { recursive: true });
  const file = path.join(tmpConfigDir, 'diff-input.txt');
  fs.writeFileSync(file, 'Email me at alice@corp.com');
  const result = runCli(['diff', '--no-color', file]);
  t.is(result.status, 0);
  t.is(result.stdout, '- Email me at alice@corp.com\n+ Email me at «Email_1»\n');
});

test.serial('CLI: sessions rm fails when session ID is missing without --all', (t) => {
  const result = runCli(['sessions', 'rm']);
  t.not(result.status, 0);
  t.true(result.stderr.includes("missing required argument 'id'"));
});

test.serial('CLI: sessions rm fails gracefully with invalid session id', (t) => {
  const result = runCli(['sessions', 'rm', 'invalid-id-xyz']);
  t.not(result.status, 0);
  t.true(result.stderr.includes('not found'));
});

test.serial('CLI: scrub --json returns structured output', (t) => {
  const result = runCli(['scrub', '--json', '--include-session-map'], 'Contact alice@example.com');

  t.is(result.status, 0);

  const output = JSON.parse(result.stdout) as {
    content: string;
    sessionId: string;
    sessionMap: Record<string, string>;
    stats: { totalEntities: number };
  };

  t.is(output.content, 'Contact «Email_1»');
  t.truthy(output.sessionId);
  t.deepEqual(output.sessionMap, {
    '«Email_1»': 'alice@example.com',
  });
  t.is(output.stats.totalEntities, 1);
});

test.serial('CLI: inspect --json returns entities and hash', (t) => {
  const result = runCli(['inspect', '--json'], 'Contact alice@example.com');

  t.is(result.status, 0);

  const output = JSON.parse(result.stdout) as {
    entities: Array<{
      category: string;
      value: string;
      placeholder: string;
      span: [number, number];
    }>;
    hash: string;
  };

  t.is(output.entities.length, 1);
  t.is(output.entities[0]?.category, 'Email');
  t.is(output.entities[0]?.value, 'alice@example.com');
  t.is(output.entities[0]?.placeholder, '«Email_1»');
  t.regex(output.hash, /^[a-f0-9]{64}$/);
});

test.serial('CLI: rehydrate --json returns restored content', (t) => {
  const scrubResult = runCli(['scrub'], 'Contact alice@example.com');
  const sessionId = scrubResult.stderr.match(/Session ID: (\S+)/)?.[1];

  t.truthy(sessionId);

  const result = runCli(['rehydrate', '--session-id', sessionId!, '--json'], 'Contact «Email_1»');

  t.is(result.status, 0);

  const output = JSON.parse(result.stdout) as {
    content: string;
    sessionId: string;
    warnings: string[];
  };

  t.is(output.content, 'Contact alice@example.com');
  t.is(output.sessionId, sessionId);
  t.deepEqual(output.warnings, []);
});

test.serial('CLI: scrub --json dedupes repeated values to same placeholder', (t) => {
  const input = 'Email alice@example.com and alice@example.com and bob@example.com';
  const result = runCli(['scrub', '--json', '--include-session-map'], input);

  t.is(result.status, 0);

  const output = JSON.parse(result.stdout) as {
    content: string;
    sessionMap: Record<string, string>;
  };

  // Find placeholders for alice and bob
  const alicePlaceholder = Object.entries(output.sessionMap).find(
    ([_, value]) => value === 'alice@example.com',
  )?.[0];
  const bobPlaceholder = Object.entries(output.sessionMap).find(
    ([_, value]) => value === 'bob@example.com',
  )?.[0];

  t.truthy(alicePlaceholder, 'alice placeholder not found');
  t.truthy(bobPlaceholder, 'bob placeholder not found');
  t.not(alicePlaceholder, bobPlaceholder); // They should be different

  // Verify the scrubbed content uses the same placeholder for alice twice
  const matches = output.content.match(/«Email_\d»/g);
  t.is(matches?.[0], matches?.[1]); // First two should be identical (both alice)
  t.not(matches?.[1], matches?.[2]); // Third should be different (bob)
});

test.serial('CLI: inspect --json dedupes repeated values to same placeholder', (t) => {
  const input = 'Email alice@example.com and alice@example.com and bob@example.com';
  const result = runCli(['inspect', '--json'], input);

  t.is(result.status, 0);

  const output = JSON.parse(result.stdout) as {
    entities: Array<{ value: string; placeholder: string }>;
  };

  t.is(output.entities.length, 3);
  // alice appears at indices 0 and 1
  t.is(output.entities[0]?.value, 'alice@example.com');
  t.is(output.entities[1]?.value, 'alice@example.com');
  t.is(output.entities[2]?.value, 'bob@example.com');

  // Both alice entities should have the SAME placeholder
  t.is(output.entities[0]?.placeholder, output.entities[1]?.placeholder);
  // Bob should have a DIFFERENT placeholder
  t.not(output.entities[1]?.placeholder, output.entities[2]?.placeholder);
});

test.serial('CLI: scrub --json with empty input emits valid JSON', (t) => {
  const result = runCli(['scrub', '--json'], '');

  t.is(result.status, 0);
  t.truthy(result.stdout);

  const output = JSON.parse(result.stdout) as {
    content: string;
    stats: { totalEntities: number };
  };

  t.is(output.content, '');
  t.is(output.stats.totalEntities, 0);
});

test.serial('CLI: inspect --json with empty input emits valid JSON', (t) => {
  const result = runCli(['inspect', '--json'], '');

  t.is(result.status, 0);
  t.truthy(result.stdout);

  const output = JSON.parse(result.stdout) as {
    entities: unknown[];
    hash: string;
  };

  t.deepEqual(output.entities, []);
  t.is(output.hash, computeHash('', []));
});

test.serial('CLI: rehydrate --json with empty input emits valid JSON', (t) => {
  const result = runCli(['rehydrate', '--session-id', 'dummy-id', '--json'], '');

  t.is(result.status, 0);
  t.truthy(result.stdout);

  const output = JSON.parse(result.stdout) as {
    content: string;
    warnings: unknown[];
  };

  t.is(output.content, '');
  t.deepEqual(output.warnings, []);
});

test.serial('CLI: scrub --json without --include-session-map omits sessionMap', (t) => {
  const result = runCli(['scrub', '--json'], 'Contact alice@example.com');

  t.is(result.status, 0);

  const output = JSON.parse(result.stdout) as Record<string, unknown>;

  t.falsy(output.sessionMap); // Should not be present
  t.truthy(output.content);
  t.truthy(output.sessionId);
  t.truthy(output.stats);
});

test.serial('CLI: scrub --json with --include-session-map includes sessionMap', (t) => {
  const result = runCli(['scrub', '--json', '--include-session-map'], 'Contact alice@example.com');

  t.is(result.status, 0);

  const output = JSON.parse(result.stdout) as {
    sessionMap: Record<string, string>;
  };

  t.truthy(output.sessionMap);
  t.true(Object.keys(output.sessionMap).length > 0);
  t.true(Object.values(output.sessionMap).includes('alice@example.com'));
});

test.serial('CLI: scrub --json works with file argument', (t) => {
  // Create a temp file
  const tmpFile = path.join(tmpFilesDir, 'test-input.txt');
  fs.mkdirSync(path.dirname(tmpFile), { recursive: true });
  fs.writeFileSync(tmpFile, 'Contact alice@example.com');

  const result = runCli(['scrub', '--json', tmpFile]);

  t.is(result.status, 0);
  t.truthy(result.stdout);

  const output = JSON.parse(result.stdout) as {
    content: string;
  };

  t.is(output.content, 'Contact «Email_1»');

  fs.unlinkSync(tmpFile);
});

test.serial('CLI: inspect --json works with file argument', (t) => {
  const tmpFile = path.join(tmpConfigDir, 'test-inspect.txt');
  fs.mkdirSync(path.dirname(tmpFile), { recursive: true });
  fs.writeFileSync(tmpFile, 'Contact alice@example.com');

  const result = runCli(['inspect', '--json', tmpFile]);

  t.is(result.status, 0);
  t.truthy(result.stdout);

  const output = JSON.parse(result.stdout) as {
    entities: Array<{ value: string }>;
  };

  t.is(output.entities.length, 1);
  t.is(output.entities[0]?.value, 'alice@example.com');

  fs.unlinkSync(tmpFile);
});

test.serial('CLI: scrub --json file error goes to stderr with exit code 1', (t) => {
  const result = runCli(['scrub', '--json', 'non-existent-file-xyz.txt']);

  t.is(result.status, 1);
  t.true(result.stderr.length > 0);
  t.false(result.stdout.length > 0);

  // Extract JSON from stderr (find content between first { and last })
  const match = result.stderr.match(/\{[\s\S]*\}/);
  t.truthy(match, 'No JSON error found in stderr');

  const error = JSON.parse(match![0]!) as { error: string };
  t.truthy(error.error);
});

test.serial('CLI: rehydrate --json file error goes to stderr with exit code 1', (t) => {
  const result = runCli([
    'rehydrate',
    '--session-id',
    'test-id',
    '--json',
    'non-existent-file-xyz.txt',
  ]);

  t.is(result.status, 1);
  t.true(result.stderr.length > 0);
  t.false(result.stdout.length > 0);

  // Extract JSON from stderr (find content between first { and last })
  const match = result.stderr.match(/\{[\s\S]*\}/);
  t.truthy(match, 'No JSON error found in stderr');
  const error = JSON.parse(match![0]!) as { error: string };
  t.truthy(error.error);
});

test.serial('CLI: inspect --json file error goes to stderr with exit code 1', (t) => {
  const result = runCli(['inspect', '--json', 'non-existent-file-xyz.txt']);

  t.is(result.status, 1);
  t.true(result.stderr.length > 0);
  t.false(result.stdout.length > 0);

  // Extract JSON from stderr (find content between first { and last })
  const match = result.stderr.match(/\{[\s\S]*\}/);
  t.truthy(match, 'No JSON error found in stderr');
  const error = JSON.parse(match![0]!) as { error: string };
  t.truthy(error.error);
});

test.serial('CLI: inspect --json placeholders match actual scrub output', (t) => {
  const input = 'Email alice@example.com and alice@example.com and bob@example.com';

  const scrubRes = runCli(['scrub', '--json'], input);
  t.is(scrubRes.status, 0);
  const scrubbed = (JSON.parse(scrubRes.stdout) as { content: string }).content;
  const scrubPlaceholders = scrubbed.match(/«[^»]+»/g) ?? [];

  const inspectRes = runCli(['inspect', '--json'], input);
  t.is(inspectRes.status, 0);
  const { entities } = JSON.parse(inspectRes.stdout) as {
    entities: Array<{ placeholder: string }>;
  };

  t.deepEqual(entities.map((e) => e.placeholder), scrubPlaceholders);
});

test.serial('CLI: scrub --json then rehydrate --json round trip', (t) => {
  const scrubRes = runCli(['scrub', '--json'], 'Contact alice@example.com');
  t.is(scrubRes.status, 0);

  const { content, sessionId } = JSON.parse(scrubRes.stdout) as {
    content: string;
    sessionId: string;
  };
  t.is(content, 'Contact «Email_1»');
  t.truthy(sessionId);

  const rehydrateRes = runCli(['rehydrate', '--session-id', sessionId, '--json'], content);
  t.is(rehydrateRes.status, 0);

  const { content: restored } = JSON.parse(rehydrateRes.stdout) as { content: string };
  t.is(restored, 'Contact alice@example.com');
});

test.serial('CLI: scrub --json omits sessionId when nothing was scrubbed', (t) => {
  const result = runCli(['scrub', '--json'], 'nothing sensitive here');
  t.is(result.status, 0);

  const output = JSON.parse(result.stdout) as Record<string, unknown>;
  t.is(output.content, 'nothing sensitive here');
  t.false('sessionId' in output);
});

test.serial('CLI: scrub --include-session-map without --json errors', (t) => {
  const result = runCli(['scrub', '--include-session-map'], 'Contact alice@example.com');

  t.is(result.status, 1);
  t.true(result.stderr.includes('requires `--json`'));
});

test('CLI: inspect prints the confidence and method of each entity', (t) => {
  const result = runCli(['inspect'], 'Contact me at alice@example.com');
  t.is(result.status, 0);
  t.true(result.stdout.includes('confidence 0.95 exact-pattern'));
});

test('CLI: inspect --min-confidence hides findings below the threshold', (t) => {
  const input = 'Call 555-123-4567 or mail alice@example.com';

  const all = runCli(['inspect'], input);
  t.true(all.stdout.includes('[Phone]'));
  t.true(all.stdout.includes('[Email]'));

  const filtered = runCli(['inspect', '--min-confidence', '0.9'], input);
  t.is(filtered.status, 0);
  const [detected, suppressed] = filtered.stdout.split('Suppressed below');
  // The phone drops out of what would be scrubbed...
  t.false(detected?.includes('[Phone]'));
  t.true(detected?.includes('[Email]'));
  // ...and is named as still being in the clear rather than vanishing.
  t.true(suppressed?.includes('[Phone]'));
});

test('CLI: scrub --min-confidence says what it suppressed', (t) => {
  // The exact command from the review.
  const result = runCli(
    ['scrub', '--min-confidence', '0.9'],
    'mail alice@example.com and call 555-123-4567',
  );

  t.is(result.status, 0);
  t.is(result.stdout, 'mail «Email_1» and call 555-123-4567');
  t.true(
    result.stderr.includes(
      'Scrubbed: 1 entity (1 Email); 1 suppressed below --min-confidence 0.9 (1 Phone)',
    ),
  );
});

test('CLI: a run where the threshold drops everything still says so', (t) => {
  // stdout is byte-identical to a prompt with nothing sensitive in it, so the
  // summary is the only thing standing between the user and a silent leak.
  const result = runCli(['scrub', '--min-confidence', '0.95'], 'call 555-123-4567');

  t.is(result.status, 0);
  t.is(result.stdout, 'call 555-123-4567');
  t.true(
    result.stderr.includes(
      'Scrubbed: 0 entities; 1 suppressed below --min-confidence 0.95 (1 Phone)',
    ),
  );
});

test('CLI: the summary is unchanged without a threshold', (t) => {
  const result = runCli(['scrub'], 'mail alice@example.com and call 555-123-4567');

  t.is(result.status, 0);
  t.true(result.stderr.includes('Scrubbed: 2 entities (1 Email, 1 Phone)'));
  t.false(result.stderr.includes('suppressed'));
});

test('CLI: -q still reports what a threshold suppressed, even when nothing survived', (t) => {
  // The worst case for a redaction tool: the threshold drops everything, so
  // stdout is byte-identical to a prompt that never had a phone number in it.
  // -q must not be what makes that silence indistinguishable from safety.
  const result = runCli(['scrub', '-q', '--min-confidence', '0.9'], 'call 555-123-4567');

  t.is(result.status, 0);
  t.is(result.stdout, 'call 555-123-4567');
  t.false(result.stderr.includes('Scrubbed:'));
  t.true(result.stderr.includes('1 suppressed below --min-confidence 0.9 (1 Phone)'));
});

test('CLI: --min-confidence rejects a value outside the 0-1 range', (t) => {
  const result = runCli(['scrub', '--min-confidence', '2'], 'mail alice@example.com');
  t.is(result.status, 1);
  t.true(result.stderr.includes('Expected a number between 0 and 1.'));
});

test('CLI: --min-confidence rejects trailing garbage rather than truncating it', (t) => {
  // parseFloat would read this as 0.9 and scrub at a threshold the user never
  // typed. Failing loudly is the only safe reading.
  const result = runCli(['scrub', '--min-confidence', '0.9zzz'], 'mail alice@example.com');
  t.is(result.status, 1);
  t.true(result.stderr.includes('Expected a number between 0 and 1.'));
});

test('CLI: scrub --min-confidence changes the inspect hash to match', (t) => {
  const input = 'Call 555-123-4567 or mail alice@example.com';
  const scrubbed = runCli(['scrub', '--min-confidence', '0.9'], input);
  const hash = runCli(['inspect', '--min-confidence', '0.9', '--hash'], input);

  t.is(scrubbed.stdout, 'Call 555-123-4567 or mail «Email_1»');
  t.is(hash.stdout.trim().length, 64);
  t.not(hash.stdout.trim(), runCli(['inspect', '--hash'], input).stdout.trim());
});

test('CLI: inspect --json with --min-confidence reports suppressed findings', (t) => {
  const result = runCli(
    ['inspect', '--json', '--min-confidence', '0.9'],
    'Call 555-123-4567 or mail alice@example.com',
  );

  t.is(result.status, 0);

  const output = JSON.parse(result.stdout) as {
    entities: Array<{ category: string; confidence: number }>;
    suppressed: Array<{ category: string; confidence: number }>;
    hash: string;
  };

  // The email survives the threshold; the phone is dropped from entities...
  t.deepEqual(output.entities.map((e) => e.category), ['Email']);
  // ...but is named as still in the clear rather than vanishing.
  t.deepEqual(output.suppressed.map((s) => s.category), ['Phone']);
  t.regex(output.hash, /^[a-f0-9]{64}$/);
});
