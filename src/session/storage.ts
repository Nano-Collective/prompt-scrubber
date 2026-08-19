import * as fs from 'node:fs';
import * as path from 'node:path';
import { getConfigDir, loadConfig } from '../core/config.js';
import { decryptSession, encryptSession, isEncryptedEnvelope } from '../core/crypto.js';
import { getCachedKey } from '../core/key-manager.js';
import type { SessionMap } from '../types/index.js';
/**
 * Gets the file path for a specific session ID.
 */
export function getSessionStoragePath(sessionId: string): string {
  return path.join(getConfigDir(), 'sessions', `${sessionId}.json`);
}

/**
 * Checks if a session map is encrypted without attempting to parse the full map.
 */
export function isSessionEncryptedSync(sessionId: string): boolean {
  const filePath = getSessionStoragePath(sessionId);
  if (!fs.existsSync(filePath)) {
    return false;
  }
  try {
    const data = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(data);
    return isEncryptedEnvelope(parsed);
  } catch {
    return false;
  }
}

/**
 * Reads a session map from disk. Returns an empty object if the file doesn't exist.
 */
export function readSessionMap(sessionId: string): SessionMap {
  const filePath = getSessionStoragePath(sessionId);
  if (!fs.existsSync(filePath)) {
    return {};
  }

  try {
    const data = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(data);

    if (isEncryptedEnvelope(parsed)) {
      const key = getCachedKey() || process.env.PROMPT_SCRUB_KEY;
      if (!key) {
        throw new Error(
          'Session is encrypted but no key is available. Please resolve the key before reading the session.',
        );
      }
      return decryptSession(parsed, key) as SessionMap;
    }

    return parsed as SessionMap;
  } catch (err: any) {
    if (
      err.message &&
      (err.message.includes('Unable to decrypt session') ||
        err.message.includes('no key is available') ||
        err.message.includes('Unsupported encryption'))
    ) {
      throw err;
    }
    if (fs.existsSync(filePath)) {
      const corruptPath = `${filePath}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(filePath, corruptPath);
      } catch {
        // Best-effort quarantine; ignore rename failure.
      }
    }
    return {};
  }
}

/**
 * Writes a session map to disk, creating necessary parent directories if they don't exist.
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
    let payload: string;

    if (config.encryptionEnabled) {
      const key = getCachedKey() || process.env.PROMPT_SCRUB_KEY;
      if (!key) {
        throw new Error(
          'Encryption is enabled but no key is available. Please resolve the key before writing the session.',
        );
      }
      const encrypted = encryptSession(map, key);
      payload = JSON.stringify(encrypted, null, 2);
    } else {
      payload = JSON.stringify(map, null, 2);
    }

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
