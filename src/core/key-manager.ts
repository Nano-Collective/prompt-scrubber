import * as readline from 'node:readline';
import { Writable } from 'node:stream';

let cachedKey: string | null = null;

/**
 * Prompts the user for a password securely (input is muted).
 */
async function promptPassword(query: string): Promise<string> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    throw new Error(
      'Encryption is enabled but no PROMPT_SCRUB_KEY was provided. Cannot prompt for password interactively because stdin or stdout is redirected.',
    );
  }

  return new Promise((resolve) => {
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

    process.stdout.write(query);
    muted = true;

    rl.question('', (password) => {
      rl.close();
      process.stdout.write('\n');
      resolve(password);
    });
  });
}

/**
 * Resolves the encryption key in deterministic order:
 * 1. Cache
 * 2. PROMPT_SCRUB_KEY environment variable
 * 3. Interactive prompt
 */
export async function getEncryptionKey(): Promise<string> {
  if (cachedKey) {
    return cachedKey;
  }

  if (process.env.PROMPT_SCRUB_KEY && process.env.PROMPT_SCRUB_KEY.length > 0) {
    cachedKey = process.env.PROMPT_SCRUB_KEY;
    return cachedKey;
  }

  // Fallback to interactive prompt
  cachedKey = await promptPassword('Enter session encryption passphrase: ');

  if (!cachedKey || cachedKey.trim().length === 0) {
    throw new Error('A valid passphrase is required for session encryption.');
  }

  return cachedKey;
}

/**
 * Gets the synchronously cached key.
 */
export function getCachedKey(): string | null {
  return cachedKey;
}
