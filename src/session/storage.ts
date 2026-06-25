import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import type { SessionMap } from '../types/index.js';

/**
 * Determines the base configuration directory based on the OS.
 */
function getConfigDir(): string {
  const platform = os.platform();
  const homedir = os.homedir();

  if (platform === 'darwin') {
    return path.join(homedir, 'Library', 'Application Support', 'prompt-scrub');
  } else if (platform === 'win32') {
    return path.join(
      process.env.APPDATA || path.join(homedir, 'AppData', 'Roaming'),
      'prompt-scrub',
    );
  } else {
    // Linux and others
    return path.join(process.env.XDG_CONFIG_HOME || path.join(homedir, '.config'), 'prompt-scrub');
  }
}

/**
 * Gets the file path for a specific session ID.
 */
export function getSessionStoragePath(sessionId: string): string {
  return path.join(getConfigDir(), 'sessions', `${sessionId}.json`);
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
    return JSON.parse(data) as SessionMap;
  } catch (error) {
    console.error(`Error reading session map for ID ${sessionId}: ${(error as Error).message}`);
    if (fs.existsSync(filePath)) {
      const corruptPath = `${filePath}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(filePath, corruptPath);
        console.warn(`Renamed corrupt session map to ${corruptPath}`);
      } catch (renameError) {
        console.error(`Failed to rename corrupt session map:`, renameError);
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
    fs.writeFileSync(tmpPath, JSON.stringify(map, null, 2), { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    console.error(`Error writing session map for ID ${sessionId}:`, error);
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
    } catch (error) {
      console.error(`Error deleting session map for ID ${sessionId}:`, error);
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
