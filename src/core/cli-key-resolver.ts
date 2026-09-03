import { getEncryptionKey } from '../core/key-manager.js';
import { SessionDecryptionError } from './crypto.js';

/**
 * Resolves the encryption key for a CLI command, printing a clean error
 * and exiting with code 1 on failure. Returns `true` when a key is now
 * cached and ready to use.
 *
 * Centralising this here keeps the four scrub/rehydrate/sessions call sites
 * in lockstep (review feedback #2: prior implementations only wrapped
 * `getEncryptionKey()` and let downstream `readSessionMap`/`writeSessionMap`
 * errors bubble up as unhandled rejections).
 */
export async function resolveEncryptionKeyOrExit(): Promise<boolean> {
  try {
    await getEncryptionKey();
    return true;
  } catch (err: unknown) {
    const message = err instanceof SessionDecryptionError ? err.message : (err as Error).message;
    console.error(message);
    process.exit(1);
    // `process.exit` is synchronous in Node, but the linter doesn't know
    // that, so guard the return.
    return false;
  }
}
