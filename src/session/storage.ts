import * as fs from 'node:fs';
import * as path from 'node:path';
import { getConfigDir, loadConfig } from '../core/config.js';
import {
  decryptSession,
  encryptSession,
  isEncryptedEnvelope,
  SessionDecryptionError,
} from '../core/crypto.js';
import { getCachedKey } from '../core/key-manager.js';
import type { SessionMap } from '../types/index.js';

// An ID becomes a file name, so it must not be able to name anything but a file in the
// sessions directory: no path separators (which also rules out `..` as a component), no
// drive or stream separator, no characters Windows reserves, and no control characters.
// Nothing else is restricted, so sessions written by earlier versions (names starting
// with `.` or `_`, spaces, non-ASCII) keep working.
const FORBIDDEN_IN_SESSION_ID = /[\\/:*?"<>|]/;

function isValidSessionId(id: string): boolean {
  if (id.length < 1 || id.length > 255 || FORBIDDEN_IN_SESSION_ID.test(id)) return false;
  for (let i = 0; i < id.length; i++) {
    if (id.charCodeAt(i) < 0x20) return false;
  }
  return true;
}

/**
 * Gets the file path for a specific session ID. IDs that could leave the sessions
 * directory are rejected.
 */
export function getSessionStoragePath(sessionId: string): string {
  if (!isValidSessionId(sessionId)) {
    throw new Error(
      `Invalid session ID ${JSON.stringify(sessionId)}: it must be 1-255 characters and must not contain path separators (/ or \\), ":", "*", "?", quotes, "<", ">", "|" or control characters.`,
    );
  }
  return path.join(getConfigDir(), 'sessions', `${sessionId}.json`);
}

/**
 * Tells the caller whether a session file currently exists on disk.
 * Cheap existence check that does not read or parse anything.
 */
export function sessionExists(sessionId: string): boolean {
  return fs.existsSync(getSessionStoragePath(sessionId));
}

/**
 * Tells the caller whether a session file is encrypted on disk. Reads and
 * parses the file in full so the discriminator is reliable; for cheaper
 * existence checks, prefer `sessionExists`.
 */
export function isSessionEncrypted(sessionId: string): boolean {
  const filePath = getSessionStoragePath(sessionId);
  if (!fs.existsSync(filePath)) {
    return false;
  }
  try {
    const data = fs.readFileSync(filePath, 'utf-8');
    const parsed: unknown = JSON.parse(data);
    return isEncryptedEnvelope(parsed);
  } catch {
    return false;
  }
}

/**
 * Reads a session map from disk. Returns an empty object if the file doesn't exist.
 *
 * Throws `SessionDecryptionError` when the file is encrypted but cannot be
 * decrypted (wrong key, tampered ciphertext, malformed envelope). Callers
 * that want the historical "swallow and start fresh" behaviour should catch
 * this error type and inspect it.
 */
export function readSessionMap(sessionId: string): SessionMap {
  const filePath = getSessionStoragePath(sessionId);
  if (!fs.existsSync(filePath)) {
    return {};
  }

  let parsed: unknown;
  try {
    const data = fs.readFileSync(filePath, 'utf-8');
    parsed = JSON.parse(data);
  } catch {
    quarantineCorruptFile(filePath);
    return {};
  }

  if (isEncryptedEnvelope(parsed)) {
    const key = getCachedKey() ?? process.env.PROMPT_SCRUB_KEY;
    if (!key) {
      throw new SessionDecryptionError(
        'Session is encrypted but no key is available. Set PROMPT_SCRUB_KEY or call setCachedEncryptionKey() before reading the session.',
      );
    }
    return decryptSession(parsed, key);
  }

  return parsed as SessionMap;
}

function quarantineCorruptFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const corruptPath = `${filePath}.corrupt-${Date.now()}`;
  try {
    fs.renameSync(filePath, corruptPath);
  } catch {
    // Best-effort quarantine; ignore rename failure.
  }
}

/**
 * Writes a session map to disk, creating necessary parent directories if they don't exist.
 *
 * Encryption rules:
 * - If `config.encryptionEnabled` is true, the map is always written encrypted.
 * - If a previous file at this path was encrypted (i.e. the user enabled
 *   encryption at some point), the new write is encrypted too. This prevents
 *   a silent plaintext downgrade when someone toggles `encryptionEnabled`
 *   off mid-session.
 * - Otherwise the map is written as plain JSON.
 */
export function writeSessionMap(sessionId: string, map: SessionMap): void {
  const filePath = getSessionStoragePath(sessionId);
  const dirPath = path.dirname(filePath);
  const tmpPath = `${filePath}.tmp`;

  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  }

  try {
    const config = loadConfig();
    const shouldEncrypt = Boolean(config.encryptionEnabled) || isSessionEncrypted(sessionId);
    const payload = shouldEncrypt
      ? JSON.stringify(encryptWithKey(map), null, 2)
      : JSON.stringify(map, null, 2);

    fs.writeFileSync(tmpPath, payload, { encoding: 'utf-8', mode: 0o600 });
    renameWithRetry(tmpPath, filePath);
  } catch (error) {
    if (fs.existsSync(tmpPath)) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {}
    }
    throw error;
  }
}

const LOCK_TIMEOUT_MS = 30_000;
const LOCK_RETRY_MS = 25;
const LOCK_STALE_MS = 2_000;
// How long a waiter gives a session another process is using before skipping it
// during garbage collection, which is best effort and must not stall a command.
const GC_LOCK_TIMEOUT_MS = 1_000;
// Windows reports a lock that is being deleted as EPERM, which clears within
// moments. A streak this long (about a second) is a real permission problem.
const LOCK_EPERM_RETRIES = 40;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Renames over `to`, retrying briefly when it is refused. Windows fails a rename
 * onto a file another process has open for reading (`EPERM`/`EACCES`/`EBUSY`),
 * and readers such as `rehydrate` take no lock.
 */
function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 20 || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) {
        throw error;
      }
      sleepSync(10);
    }
  }
}

/**
 * Best effort. Called from a `finally`, so throwing here would replace the result
 * of work that already finished (a scrub that already saved its session) with an
 * error. A lock that cannot be removed is left to be taken over as stale once its
 * owner has exited.
 */
function releaseLock(lockPath: string): void {
  try {
    // Windows can refuse a delete while another process is mid-read of the file.
    fs.rmSync(lockPath, { force: true, maxRetries: 5, retryDelay: 20 });
  } catch {}
}

/**
 * A lock is stale when it is old and the process that wrote its PID into it no
 * longer exists. The age matters: a holder that has just released and exited
 * also looks dead, and by the time a waiter acts on that the file may be a new
 * holder's lock. A lock is held for milliseconds, so one this old can only be
 * left behind by a crash.
 */
function isLockStale(lockPath: string): boolean {
  try {
    if (Date.now() - fs.statSync(lockPath).mtimeMs < LOCK_STALE_MS) return false;
    const pid = Number.parseInt(fs.readFileSync(lockPath, 'utf-8'), 10);
    // No PID: the holder died between creating the lock and writing it.
    if (!Number.isInteger(pid) || pid <= 0) return true;
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/**
 * Removes `lockPath` if it is stale. Deleting by path is not atomic: two waiters
 * can both judge the same lock stale, the first deletes it and a new holder
 * creates its own lock at that path, and the second then deletes the new
 * holder's live lock. So only one waiter at a time may delete a lock (the
 * `.takeover` file, created with `wx`), and it checks staleness again while
 * holding that. Nothing else removes a lock that passes the check - a live
 * holder is not stale - so what it checked is what it deletes.
 *
 * The takeover file is held for microseconds. One left behind by a crash inside
 * that window is cleared by the same age and PID rule.
 */
function breakStaleLock(lockPath: string): void {
  const takeoverPath = `${lockPath}.takeover`;
  try {
    fs.writeFileSync(takeoverPath, String(process.pid), { flag: 'wx', mode: 0o600 });
  } catch {
    // Another waiter is taking over; the caller retries.
    if (isLockStale(takeoverPath)) releaseLock(takeoverPath);
    return;
  }
  try {
    if (isLockStale(lockPath)) releaseLock(lockPath);
  } finally {
    releaseLock(takeoverPath);
  }
}

/**
 * Runs `fn` while holding an exclusive lock on the session, so that a
 * read-modify-write of the session file cannot interleave with another
 * process's. The file is read when a session is opened and rewritten whole on
 * save: without the lock, two processes sharing an ID number their
 * placeholders from the same starting state (two values get `«Email_1»`) and the
 * last save erases the other's mappings. Placeholders are already in the output
 * by the time a save happens, so they cannot be renumbered afterwards - the lock
 * has to span the read as well.
 *
 * Waits up to `timeoutMs` for the current holder, and takes over a lock left by
 * a process that died. Not re-entrant. The wait blocks the whole event loop
 * (it is a synchronous sleep), so a caller that must stay responsive should not
 * share a session ID with other processes.
 */
export function withSessionLock<T>(sessionId: string, fn: () => T, timeoutMs = LOCK_TIMEOUT_MS): T {
  const lockPath = `${getSessionStoragePath(sessionId)}.lock`;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + timeoutMs;
  let denied = 0;

  for (;;) {
    try {
      fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx', mode: 0o600 });
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'EPERM') throw error;
      // Rethrow a lasting EPERM as itself instead of reporting it as a timeout.
      denied = code === 'EPERM' ? denied + 1 : 0;
      if (denied > LOCK_EPERM_RETRIES) throw error;
      if (isLockStale(lockPath)) breakStaleLock(lockPath);
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out after ${timeoutMs} ms waiting for another prompt-scrub process to finish with session ${JSON.stringify(sessionId)}. If none is running, delete ${lockPath}.`,
        );
      }
      sleepSync(LOCK_RETRY_MS);
    }
  }

  try {
    return fn();
  } finally {
    releaseLock(lockPath);
  }
}

function encryptWithKey(map: SessionMap) {
  const key = getCachedKey() ?? process.env.PROMPT_SCRUB_KEY;
  if (!key) {
    throw new SessionDecryptionError(
      'Encryption is enabled but no key is available. Set PROMPT_SCRUB_KEY or call setCachedEncryptionKey() before writing the session.',
    );
  }
  return encryptSession(map, key);
}

/**
 * Deletes a session map from disk.
 */
export function deleteSessionMap(sessionId: string): boolean {
  const filePath = getSessionStoragePath(sessionId);
  if (fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Lists all available session IDs by inspecting the storage directory.
 */
export function listSessions(): Array<{ id: string; sizeBytes: number; lastModifiedAt: Date }> {
  const sessionsDir = path.join(getConfigDir(), 'sessions');
  if (!fs.existsSync(sessionsDir)) {
    return [];
  }

  const files = fs.readdirSync(sessionsDir).filter((file) => file.endsWith('.json'));
  return files
    .map((file) => {
      const filePath = path.join(sessionsDir, file);
      const stats = fs.statSync(filePath);
      return {
        id: path.basename(file, '.json'),
        sizeBytes: stats.size,
        mtimeMs: stats.mtimeMs,
        lastModifiedAt: stats.mtime,
      };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map(({ id, sizeBytes, lastModifiedAt }) => ({ id, sizeBytes, lastModifiedAt }));
}

/**
 * Garbage collect sessions that are older than the specified TTL days.
 */
export function gcSessions(ttlDays: number): number {
  if (ttlDays <= 0) return 0;

  const sessionsDir = path.join(getConfigDir(), 'sessions');
  if (!fs.existsSync(sessionsDir)) return 0;

  let deletedCount = 0;
  const now = Date.now();
  const ttlMs = ttlDays * 24 * 60 * 60 * 1000;

  const files = fs.readdirSync(sessionsDir);
  for (const file of files) {
    const filePath = path.join(sessionsDir, file);
    try {
      const expired = () => now - fs.statSync(filePath).mtimeMs >= ttlMs;
      if (!expired()) continue;
      const id = path.basename(file, '.json');
      if (file.endsWith('.json') && isValidSessionId(id)) {
        // A scrub may be reading or saving this session right now. Take its lock
        // and look again: a save that landed since the check above makes it
        // current, and deleting it would throw away that scrub's mappings.
        withSessionLock(
          id,
          () => {
            if (!expired()) return;
            fs.unlinkSync(filePath);
            deletedCount++;
          },
          GC_LOCK_TIMEOUT_MS,
        );
      } else {
        fs.unlinkSync(filePath);
      }
    } catch {
      // Best-effort cleanup: ignore individual failures so other files can still be processed.
    }
  }

  return deletedCount;
}
