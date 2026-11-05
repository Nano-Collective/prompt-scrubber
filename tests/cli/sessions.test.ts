import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'ava';
import { Command } from 'commander';
import { setupSessionsCommands } from '../../src/cli/commands/sessions.js';
import { clearCachedEncryptionKey, setCachedEncryptionKey } from '../../src/core/key-manager.js';
import {
  deleteSessionMap,
  getSessionStoragePath,
  listSessions,
  readSessionMap,
  writeSessionMap,
} from '../../src/session/storage.js';

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

test.serial(
  'sessions list keeps working when a saved session has an unusual file name',
  async (t) => {
    const dir = path.join(process.env.PROMPT_SCRUB_CONFIG_DIR!, 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    const names = ['.hidden', '_draft', 'with space', 'josé', 'plain'];
    for (const name of names) {
      fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({ '«Email_1»': 'a@b.com' }));
    }
    t.teardown(() => {
      for (const name of names) fs.rmSync(path.join(dir, `${name}.json`), { force: true });
    });

    const program = new Command();
    setupSessionsCommands(program);
    const originalLog = console.log;
    const lines: string[] = [];
    console.log = (...args: unknown[]) => {
      lines.push(args.join(' '));
    };
    try {
      await program.parseAsync(['node', 'prompt-scrub', 'sessions', 'list']);
    } finally {
      console.log = originalLog;
    }

    const output = lines.join('\n');
    for (const name of names) t.true(output.includes(name), `${name} missing from:\n${output}`);
  },
);

test.serial('sessions rm removes a session whose name starts with a dot', async (t) => {
  const dir = path.join(process.env.PROMPT_SCRUB_CONFIG_DIR!, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.legacy.json'), JSON.stringify({ '«Email_1»': 'a@b.com' }));

  const program = new Command();
  setupSessionsCommands(program);
  const originalLog = console.log;
  console.log = () => {};
  try {
    await program.parseAsync(['node', 'prompt-scrub', 'sessions', 'rm', '.legacy']);
  } finally {
    console.log = originalLog;
  }
  t.false(fs.existsSync(path.join(dir, '.legacy.json')));
});

/** Runs `prompt-scrub sessions <args>` in-process and captures what it printed and its exit code. */
async function runSessions(args: string[]) {
  const program = new Command();
  setupSessionsCommands(program);
  const originalExit = process.exit;
  const originalLog = console.log;
  const originalError = console.error;
  const result = { exitCode: undefined as number | undefined, out: '', err: '' };
  process.exit = ((code?: number) => {
    result.exitCode = code;
  }) as unknown as typeof process.exit;
  console.log = (msg: string) => {
    result.out += msg;
  };
  console.error = (msg: string) => {
    result.err += msg;
  };
  try {
    await program.parseAsync(['node', 'test', 'sessions', ...args]);
  } finally {
    process.exit = originalExit;
    console.log = originalLog;
    console.error = originalError;
  }
  return result;
}

/**
 * Marks a session as in use by a live process: a fresh lock file naming this PID
 * and a different module instance, so it is neither stale nor ours to take back.
 * Returns a function that removes it.
 */
function holdLock(id: string): () => void {
  const lockPath = `${getSessionStoragePath(id)}.lock`;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, `${process.pid}:another-process`);
  return () => fs.rmSync(lockPath, { force: true });
}

/** Makes the 30 s lock wait elapse at once: every clock read jumps 10 s ahead. */
async function withFastClock<T>(fn: () => Promise<T>): Promise<T> {
  const realNow = Date.now;
  let skew = 0;
  Date.now = () => realNow() + (skew += 10_000);
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
}

test.serial(
  'sessions rm names a session another process is using instead of crashing',
  async (t) => {
    writeSessionMap('rm-in-use', { '«Email_1»': 'busy@example.com' });
    const release = holdLock('rm-in-use');
    try {
      const result = await withFastClock(() => runSessions(['rm', 'rm-in-use']));
      t.is(result.exitCode, 1);
      t.regex(result.err, /Timed out.*"rm-in-use"/);
      t.false(result.err.includes('    at ')); // a message, not a stack trace
    } finally {
      release();
    }
    t.deepEqual(readSessionMap('rm-in-use'), { '«Email_1»': 'busy@example.com' });
    deleteSessionMap('rm-in-use');
  },
);

test.serial(
  'sessions rm --all skips a session in use, deletes the rest and counts them',
  async (t) => {
    for (const id of ['rm-all-a', 'rm-all-busy', 'rm-all-c']) {
      writeSessionMap(id, { '«Email_1»': `${id}@example.com` });
    }
    const release = holdLock('rm-all-busy');
    let result: Awaited<ReturnType<typeof runSessions>>;
    let remaining: string[];
    try {
      result = await withFastClock(() => runSessions(['rm', '--all']));
      remaining = listSessions().map((s) => s.id);
    } finally {
      release();
    }
    t.deepEqual(remaining, ['rm-all-busy']); // the sessions after the busy one were still deleted
    t.is(result.out, 'Deleted 2 sessions.');
    t.regex(result.err, /Timed out.*"rm-all-busy"/);
    t.regex(result.err, /1 session\(s\) in use were not deleted/);
    t.is(result.exitCode, 1);
    deleteSessionMap('rm-all-busy');
  },
);

test.serial(
  'sessions encrypt names a session another process is using instead of crashing',
  async (t) => {
    const configPath = path.join(tmpConfigDir, 'prompt-scrub', 'config.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ encryptionEnabled: true }));
    setCachedEncryptionKey('cli-encrypt-key');
    process.env.PROMPT_SCRUB_KEY = 'cli-encrypt-key';
    const sessionPath = getSessionStoragePath('encrypt-in-use');
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(sessionPath, JSON.stringify({ '«Email_1»': 'busy@example.com' }));
    const release = holdLock('encrypt-in-use');
    try {
      const result = await withFastClock(() => runSessions(['encrypt', 'encrypt-in-use']));
      t.is(result.exitCode, 1);
      t.regex(result.err, /Timed out.*"encrypt-in-use"/);
      t.false(result.err.includes('    at '));
    } finally {
      release();
      clearCachedEncryptionKey();
      delete process.env.PROMPT_SCRUB_KEY;
      fs.rmSync(configPath);
    }
    // Left alone, still plaintext.
    t.deepEqual(JSON.parse(fs.readFileSync(sessionPath, 'utf-8')), {
      '«Email_1»': 'busy@example.com',
    });
    fs.rmSync(sessionPath);
  },
);
