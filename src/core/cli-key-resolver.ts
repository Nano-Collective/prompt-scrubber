import { SessionDecryptionError } from './crypto.js';
import { getEncryptionKey } from './key-manager.js';

/**
 * Resolves the encryption key for a CLI command, printing a clean error
 * and exiting with code 1 on failure. Returns `true` when a key is now
 * cached and ready to use, `false` if the process was terminated (this
 * branch never actually returns — `process.exit` is synchronous — but the
 * explicit fallback keeps TypeScript and Biome happy).
 */
export async function resolveEncryptionKeyOrExit(): Promise<boolean> {
  try {
    await getEncryptionKey();
    return true;
  } catch (err: unknown) {
    const message =
      err instanceof SessionDecryptionError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    console.error(message);
    process.exit(1);
    return false;
  }
}

/**
 * Wraps a CLI action body so that both key-resolution errors and
 * storage/decryption errors are translated into a single clean one-line
 * message + non-zero exit. Use this in every command that calls into
 * `readSessionMap`/`writeSessionMap` so a wrong `PROMPT_SCRUB_KEY` never
 * escapes as an unhandled rejection with a raw stack trace.
 */
export async function runCliAction(action: () => Promise<void> | void): Promise<void> {
  try {
    await action();
  } catch (err: unknown) {
    const message =
      err instanceof SessionDecryptionError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    console.error(message);
    process.exit(1);
  }
}
