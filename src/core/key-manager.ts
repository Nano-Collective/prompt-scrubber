import * as readline from 'node:readline';
import { Writable } from 'node:stream';
import { clearDerivedKeyCache } from './crypto.js';

let cachedKey: string | null = null;

export interface PromptIO {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  isTTY: boolean;
}

/**
 * Reads the default IO from `process.stdin`/`process.stdout` and their TTY
 * flags. Extracted so tests can inject a fake TTY without monkey-patching
 * the global `process` object.
 */
function defaultIO(): PromptIO {
  return {
    input: process.stdin,
    output: process.stdout,
    isTTY: Boolean(process.stdout.isTTY && process.stdin.isTTY),
  };
}

/**
 * Prompts the user for a password securely (input is muted). The IO streams
 * and TTY gate are taken from the optional `io` argument so tests can drive
 * the prompt without touching globals; production callers omit it.
 */
export async function promptPassword(query: string, io: PromptIO = defaultIO()): Promise<string> {
  if (!io.isTTY) {
    throw new Error(
      'Encryption is enabled but no PROMPT_SCRUB_KEY was provided. Cannot prompt for password interactively because stdin or stdout is redirected.',
    );
  }

  return new Promise((resolve, reject) => {
    let muted = false;
    const mutableStdout = new Writable({
      write(chunk, encoding, callback) {
        if (!muted) {
          (io.output as NodeJS.WritableStream).write(chunk, encoding);
        }
        callback();
      },
    });

    const rl = readline.createInterface({
      input: io.input,
      output: mutableStdout,
      terminal: true,
    });

    rl.on('error', reject);

    (io.output as NodeJS.WritableStream).write(query);
    muted = true;

    rl.question('', (inputKey) => {
      rl.close();
      (io.output as NodeJS.WritableStream).write('\n');
      resolve(inputKey);
    });
  });
}

/**
 * Asserts a key is a non-empty, non-whitespace string. Returns it
 * unchanged so callers that intentionally use leading/trailing spaces in
 * a passphrase still get exactly what they typed.
 */
export function assertValidKey(inputKey: unknown): string {
  if (typeof inputKey !== 'string' || inputKey.length === 0 || inputKey.trim().length === 0) {
    throw new Error('A valid key is required for session encryption.');
  }
  return inputKey;
}

/**
 * Resolves the encryption key in deterministic order:
 * 1. Cache
 * 2. PROMPT_SCRUB_KEY environment variable
 * 3. Interactive prompt (prompted once)
 *
 * Set `confirm: true` to prompt twice on a fresh key — this is the
 * recommended path when first enabling encryption because a typo here will
 * permanently lock the session.
 */
export async function getEncryptionKey(
  options: { confirm?: boolean; io?: PromptIO } = {},
): Promise<string> {
  if (cachedKey !== null) {
    return cachedKey;
  }

  if (process.env.PROMPT_SCRUB_KEY !== undefined && process.env.PROMPT_SCRUB_KEY.length > 0) {
    const fromEnv = assertValidKey(process.env.PROMPT_SCRUB_KEY);
    return setCachedEncryptionKey(fromEnv);
  }

  const io = options.io;
  const first = await promptPassword('Enter session encryption key: ', io);
  const normalisedFirst = assertValidKey(first);

  if (options.confirm) {
    const second = await promptPassword('Confirm session encryption key: ', io);
    const normalisedSecond = assertValidKey(second);
    if (normalisedFirst !== normalisedSecond) {
      throw new Error('Keys do not match. Aborting before writing any encrypted session.');
    }
  }

  return setCachedEncryptionKey(normalisedFirst);
}

/**
 * Synchronously returns the cached key, or `null` if none has been resolved
 * yet in this process. Useful for hot paths that already know a key is loaded.
 */
export function getCachedKey(): string | null {
  return cachedKey;
}

/**
 * Test/library API to inject a key directly without going through the env
 * var or interactive prompt. Bypasses validation to allow callers to supply
 * empty/whitespace keys deliberately when needed for tests.
 */
export function setCachedEncryptionKey(inputKey: string): string {
  if (typeof inputKey !== 'string' || inputKey.length === 0) {
    throw new Error('Encryption key must be a non-empty string.');
  }
  cachedKey = inputKey;
  return cachedKey;
}

/**
 * Clears the cached key and any derived key material so nothing sensitive
 * outlives the explicit "lock" request. Intended for tests; production code
 * rarely needs this because the process is typically short-lived.
 */
export function clearCachedEncryptionKey(): void {
  cachedKey = null;
  clearDerivedKeyCache();
}
