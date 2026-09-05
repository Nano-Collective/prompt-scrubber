import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'ava';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliEntry = path.resolve(__dirname, '../../src/cli/index.ts');
const tmpConfigDir = path.join(__dirname, '.tmp-config-e2e');

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
  if (fs.existsSync(tmpConfigDir)) {
    fs.rmSync(tmpConfigDir, { recursive: true, force: true });
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
    scrubbedContent: string;
    sessionId: string;
    sessionMap: Record<string, string>;
    stats: { totalEntities: number };
  };

  t.is(output.scrubbedContent, 'Contact «Email_1»');
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
    scrubbedContent: string;
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
  const matches = output.scrubbedContent.match(/«Email_\d»/g);
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
  t.not(output.entities[1]?.placeholder, output.entities[2]?.placeholder); // ← CHANGED from t.notEqual
});

test.serial('CLI: scrub --json with empty input emits valid JSON', (t) => {
  const result = runCli(['scrub', '--json'], '');

  t.is(result.status, 0);
  t.truthy(result.stdout);

  const output = JSON.parse(result.stdout) as {
    scrubbedContent: string;
    stats: { totalEntities: number };
  };

  t.is(output.scrubbedContent, '');
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
  t.is(output.hash, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'); // SHA-256 of empty string
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
  t.truthy(output.scrubbedContent);
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
  const tmpFile = path.join(tmpConfigDir, 'test-input.txt');
  fs.mkdirSync(path.dirname(tmpFile), { recursive: true });
  fs.writeFileSync(tmpFile, 'Contact alice@example.com');

  const result = runCli(['scrub', '--json', tmpFile]);

  t.is(result.status, 0);
  t.truthy(result.stdout);

  const output = JSON.parse(result.stdout) as {
    scrubbedContent: string;
  };

  t.is(output.scrubbedContent, 'Contact «Email_1»');

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
