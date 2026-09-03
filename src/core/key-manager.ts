import * as readline from 'node:readline';
import { Writable } from 'node:stream';

let cachedKey: string | null = null;

/**
 * Prompts the user for a password securely (input is muted).
 */
export async function promptPassword(query: string): Promise<string> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    throw new Error(
      'Encryption is enabled but no PROMPT_SCRUB_KEY was provided. Cannot prompt for password interactively because stdin or stdout is redirected.',
    );
  }

  return new Promise((resolve, reject) => {
    let muted = false;
    const mutableStdout = new Writable({
      write(chunk, encoding, callback) {
        if (!muted) {
          process.stdout.write(chunk, encoding);
        }
        callback();
      },
    });

    const rl = readline.createInterface({
      input: process.stdin,
      output: mutableStdout,
      terminal: true,
    });

    rl.on('error', reject);

    process.stdout.write(query);
    muted = true;

    rl.question('', (inputKey) => {
      rl.close();
      process.stdout.write('\n');
      resolve(inputKey);
    });
  });
}

/**
 * Validates and returns a normalised passphrase, throwing if empty/whitespace.
 */
export function normaliseInputKey(inputKey: string): string {
  if (typeof inputKey !== 'string' || inputKey.trim().length === 0) {
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
export async function getEncryptionKey(options: { confirm?: boolean } = {}): Promise<string> {
  if (cachedKey !== null) {
    return cachedKey;
  }

  if (process.env.PROMPT_SCRUB_KEY && process.env.PROMPT_SCRUB_KEY.length > 0) {
    return setCachedEncryptionKey(process.env.PROMPT_SCRUB_KEY);
  }

  const first = await promptPassword('Enter session encryption key: ');
  const normalisedFirst = normaliseInputKey(first);

  if (options.confirm) {
    const second = await promptPassword('Confirm session encryption key: ');
    const normalisedSecond = normaliseInputKey(second);
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
 * Clears the cached key. Intended for tests; production code rarely needs
 * this because the process is typically short-lived.
 */
export function clearCachedEncryptionKey(): void {
  cachedKey = null;
}
