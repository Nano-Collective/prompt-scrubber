import * as fs from 'node:fs';
import * as path from 'node:path';
import { getConfigDir, loadConfig } from '../core/config.js';
import {
  SessionDecryptionError,
  decryptSession,
  encryptSession,
  isEncryptedEnvelope,
} from '../core/crypto.js';
import { getCachedKey } from '../core/key-manager.js';
import type { SessionMap } from '../types/index.js';

/**
 * Gets the file path for a specific session ID.
 */
export function getSessionStoragePath(sessionId: string): string {
  return path.join(getConfigDir(), 'sessions', `${sessionId}.json`);
}

/**
 * Quickly tells the caller whether a session file is encrypted on disk.
 * Reads and parses the file in full so the discriminator is reliable; for
 * CLI listings that want a cheap existence check, prefer `fs.existsSync`.
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
      ? JSON.stringify(encryptWithKey(map, shouldEncrypt), null, 2)
      : JSON.stringify(map, null, 2);

    fs.writeFileSync(tmpPath, payload, { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    if (fs.existsSync(tmpPath)) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {}
    }
    throw error;
  }
}

function encryptWithKey(map: SessionMap, _confirmed: boolean) {
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
export function listSessions(): Array<{ id: string; sizeBytes: number; createdAt: Date }> {
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
        createdAt: stats.mtime,
      };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map(({ id, sizeBytes, createdAt }) => ({ id, sizeBytes, createdAt }));
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
      const stats = fs.statSync(filePath);
      const ageMs = now - stats.mtimeMs;
      if (ageMs >= ttlMs) {
        fs.unlinkSync(filePath);
        if (file.endsWith('.json')) {
          deletedCount++;
        }
      }
    } catch {
      // Best-effort cleanup: ignore individual failures so other files can still be processed.
    }
  }

  return deletedCount;
}
