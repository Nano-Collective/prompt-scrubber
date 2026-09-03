import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'ava';
import { SessionDecryptionError, clearDerivedKeyCache } from '../src/core/crypto.js';
import { clearCachedEncryptionKey, setCachedEncryptionKey } from '../src/core/key-manager.js';
import {
  deleteSessionMap,
  gcSessions,
  getSessionStoragePath,
  isSessionEncrypted,
  listSessions,
  readSessionMap,
  writeSessionMap,
} from '../src/session/storage.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const tmpConfigDir = path.join(__dirname, '.tmp-config');

test.before(() => {
  // Redirect storage to a local temp folder instead of the user's real config dir.
  // PROMPT_SCRUB_CONFIG_DIR is honored on every platform; XDG_CONFIG_HOME is only
  // read on non-darwin non-win32 platforms, so it's not enough for tests on macOS.
  process.env.PROMPT_SCRUB_CONFIG_DIR = path.join(tmpConfigDir, 'prompt-scrub');

  // Clean up if it exists from a previous failed run
  if (fs.existsSync(tmpConfigDir)) {
    fs.rmSync(tmpConfigDir, { recursive: true, force: true });
  }
});

test.after.always(() => {
  // Clean up the temporary config directory
  if (fs.existsSync(tmpConfigDir)) {
    fs.rmSync(tmpConfigDir, { recursive: true, force: true });
  }
  // Reset any globals tests may have set so other files run clean.
  clearCachedEncryptionKey();
  clearDerivedKeyCache();
  delete process.env.PROMPT_SCRUB_KEY;
});

test.serial('readSessionMap returns {} on missing file', (t) => {
  const result = readSessionMap('non-existent-id');
  t.deepEqual(result, {});
});

test.serial('writeSessionMap creates parent dirs and readSessionMap reads it back', (t) => {
  const id = 'test-write-id';
  const map = { '«Email_1»': 'test@example.com' };

  writeSessionMap(id, map);

  const readMap = readSessionMap(id);
  t.deepEqual(readMap, map);
});

test.serial(
  'writeSessionMap handles JSON parse errors gracefully by renaming corrupt files',
  (t) => {
    const id = 'corrupt-test-id';
    const map = { '«Secret_1»': 'sk-1234' };

    writeSessionMap(id, map);

    // Manually corrupt the file
    const sessionsDir = path.join(tmpConfigDir, 'prompt-scrub', 'sessions');
    const filePath = path.join(sessionsDir, `${id}.json`);
    fs.writeFileSync(filePath, '{ corrupt_json: ]', 'utf-8');

    // Suppress the expected console.error/warn output from the corrupt-file handler
    const originalError = console.error;
    const originalWarn = console.warn;
    console.error = () => {};
    console.warn = () => {};

    const readMap = readSessionMap(id);

    console.error = originalError;
    console.warn = originalWarn;

    t.deepEqual(readMap, {}); // Should return empty on failure

    // Verify corrupt file was renamed
    t.false(fs.existsSync(filePath), 'Original file should be renamed');
    const files = fs.readdirSync(sessionsDir);
    const corruptFile = files.find((f) => f.includes(`${id}.json.corrupt-`));
    t.truthy(corruptFile, 'Corrupt file should exist with a timestamp suffix');
  },
);

test.serial('deleteSessionMap returns true on hit and false on miss', (t) => {
  const id = 'delete-test-id';
  writeSessionMap(id, { '«Path_1»': '/var/log' });

  const deletedExisting = deleteSessionMap(id);
  t.true(deletedExisting);

  const deletedMissing = deleteSessionMap(id);
  t.false(deletedMissing);
});

test.serial('deleteSessionMap handles unlinkSync error', (t) => {
  const id = 'delete-fail-test-id';
  const filePath = getSessionStoragePath(id);
  const dirPath = path.dirname(filePath);

  writeSessionMap(id, { '«Secret_1»': 'sk-fail' });
  fs.chmodSync(dirPath, 0o555); // make directory read-only so unlink fails

  const originalError = console.error;
  console.error = () => {};

  const result = deleteSessionMap(id);
  t.false(result);

  console.error = originalError;
  fs.chmodSync(dirPath, 0o777); // restore
});

test.serial('listSessions ignores non-.json files', (t) => {
  const id = 'list-test-id';
  writeSessionMap(id, { '«Phone_1»': '555-1234' });

  const sessionsDir = path.join(tmpConfigDir, 'prompt-scrub', 'sessions');
  // Create some junk files
  fs.writeFileSync(path.join(sessionsDir, 'junk.txt'), 'hello', 'utf-8');
  fs.writeFileSync(path.join(sessionsDir, `${id}.json.tmp`), '{}', 'utf-8');

  const sessions = listSessions();
  const fileIds = sessions.map((s) => s.id);

  t.true(fileIds.includes(id));
  t.false(fileIds.includes('junk'));
  t.false(fileIds.includes(`${id}.json`)); // shouldn't match the `.tmp` extension incorrectly
});

test.serial('listSessions returns sessions sorted by most recently modified', async (t) => {
  const id1 = 'sort-test-1';
  const id2 = 'sort-test-2';

  writeSessionMap(id1, { '«Email_1»': 'a@b.com' });
  // Need a small delay so mtime is strictly greater
  await new Promise((r) => setTimeout(r, 10));
  writeSessionMap(id2, { '«Email_1»': 'c@d.com' });

  const sessions = listSessions();
  // Filter out other tests' sessions
  const sorted = sessions.filter((s) => s.id.startsWith('sort-test-'));

  t.is(sorted.length, 2);
  t.is(sorted[0]!.id, id2); // most recently written comes first
  t.is(sorted[1]!.id, id1);
});

test.serial('getSessionStoragePath returns correctly formatted path', (t) => {
  const p = getSessionStoragePath('123');
  t.true(p.endsWith(path.join('prompt-scrub', 'sessions', '123.json')));
});

test.serial('getConfigDir handles darwin', (t) => {
  const originalOverride = process.env.PROMPT_SCRUB_CONFIG_DIR;
  const originalMock = process.env.MOCK_PLATFORM;
  delete process.env.PROMPT_SCRUB_CONFIG_DIR;
  process.env.MOCK_PLATFORM = 'darwin';

  const p = getSessionStoragePath('test');
  t.true(
    p.includes(
      path.join('Library', 'Application Support', 'prompt-scrub', 'sessions', 'test.json'),
    ),
  );

  process.env.PROMPT_SCRUB_CONFIG_DIR = originalOverride;
  process.env.MOCK_PLATFORM = originalMock;
});

test.serial('getConfigDir handles win32 with APPDATA', (t) => {
  const originalOverride = process.env.PROMPT_SCRUB_CONFIG_DIR;
  const originalMock = process.env.MOCK_PLATFORM;
  const originalAppData = process.env.APPDATA;
  delete process.env.PROMPT_SCRUB_CONFIG_DIR;
  process.env.MOCK_PLATFORM = 'win32';
  process.env.APPDATA = '/mock/appdata';

  const p = getSessionStoragePath('test');
  t.true(p.includes(path.join('mock', 'appdata', 'prompt-scrub')));

  process.env.PROMPT_SCRUB_CONFIG_DIR = originalOverride;
  process.env.MOCK_PLATFORM = originalMock;
  process.env.APPDATA = originalAppData;
});

test.serial('getConfigDir handles win32 without APPDATA fallback to AppData/Roaming', (t) => {
  const originalOverride = process.env.PROMPT_SCRUB_CONFIG_DIR;
  const originalMock = process.env.MOCK_PLATFORM;
  const originalAppData = process.env.APPDATA;
  delete process.env.PROMPT_SCRUB_CONFIG_DIR;
  process.env.MOCK_PLATFORM = 'win32';
  delete process.env.APPDATA;

  const p = getSessionStoragePath('test');
  t.true(p.includes(path.join('AppData', 'Roaming', 'prompt-scrub')));

  process.env.PROMPT_SCRUB_CONFIG_DIR = originalOverride;
  process.env.MOCK_PLATFORM = originalMock;
  process.env.APPDATA = originalAppData;
});

test.serial('getConfigDir handles linux with XDG_CONFIG_HOME', (t) => {
  const originalOverride = process.env.PROMPT_SCRUB_CONFIG_DIR;
  const originalMock = process.env.MOCK_PLATFORM;
  const originalXdg = process.env.XDG_CONFIG_HOME;
  delete process.env.PROMPT_SCRUB_CONFIG_DIR;
  process.env.MOCK_PLATFORM = 'linux';
  process.env.XDG_CONFIG_HOME = '/mock/xdg';

  const p = getSessionStoragePath('test');
  t.true(p.includes(path.join('mock', 'xdg', 'prompt-scrub')));

  process.env.PROMPT_SCRUB_CONFIG_DIR = originalOverride;
  process.env.MOCK_PLATFORM = originalMock;
  process.env.XDG_CONFIG_HOME = originalXdg;
});

test.serial('getConfigDir handles linux without XDG_CONFIG_HOME fallback to .config', (t) => {
  const originalOverride = process.env.PROMPT_SCRUB_CONFIG_DIR;
  const originalMock = process.env.MOCK_PLATFORM;
  const originalXdg = process.env.XDG_CONFIG_HOME;
  delete process.env.PROMPT_SCRUB_CONFIG_DIR;
  process.env.MOCK_PLATFORM = 'linux';
  delete process.env.XDG_CONFIG_HOME;

  const p = getSessionStoragePath('test');
  t.true(p.includes(path.join('.config', 'prompt-scrub')));

  process.env.PROMPT_SCRUB_CONFIG_DIR = originalOverride;
  process.env.MOCK_PLATFORM = originalMock;
  process.env.XDG_CONFIG_HOME = originalXdg;
});

test.serial('writeSessionMap failure path handles unlinkSync error', (t) => {
  const id = 'write-fail-test';
  const filePath = getSessionStoragePath(id);
  const tmpPath = `${filePath}.tmp`;

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.mkdirSync(tmpPath, { recursive: true }); // Cause EISDIR

  const originalError = console.error;
  console.error = () => {};

  t.throws(() => {
    writeSessionMap(id, { '«Email_1»': 'fail@test.com' });
  });

  console.error = originalError;
  fs.rmSync(tmpPath, { recursive: true, force: true });
});

test.serial('readSessionMap fails to rename corrupt file gracefully', (t) => {
  const id = 'corrupt-rename-fail-test';
  const filePath = getSessionStoragePath(id);
  const dirPath = path.dirname(filePath);

  writeSessionMap(id, { '«Secret_1»': 'sk-1234' });
  fs.writeFileSync(filePath, '{ bad json', 'utf-8');

  fs.chmodSync(dirPath, 0o555); // Read-only directory prevents rename

  const originalError = console.error;
  const originalWarn = console.warn;
  console.error = () => {};
  console.warn = () => {};

  const readMap = readSessionMap(id);

  console.error = originalError;
  console.warn = originalWarn;

  t.deepEqual(readMap, {});
  fs.chmodSync(dirPath, 0o777); // Restore to allow cleanup
});

test.serial('gcSessions removes expired sessions and keeps active ones', (t) => {
  const idExpired = 'gc-test-expired';
  const idActive = 'gc-test-active';

  writeSessionMap(idExpired, { '«Email_1»': 'old@test.com' });
  writeSessionMap(idActive, { '«Email_1»': 'new@test.com' });

  // Artificially age the expired session by 10 days
  const expiredPath = getSessionStoragePath(idExpired);
  const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
  fs.utimesSync(expiredPath, tenDaysAgo, tenDaysAgo);

  const deletedCount = gcSessions(7);

  t.is(deletedCount, 1);
  t.false(fs.existsSync(expiredPath));
  t.true(fs.existsSync(getSessionStoragePath(idActive)));
});

test.serial('gcSessions returns 0 if ttlDays is 0 or less', (t) => {
  const id = 'gc-test-zero-ttl';
  writeSessionMap(id, { '«Email_1»': 'zero@test.com' });

  const oldPath = getSessionStoragePath(id);
  const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
  fs.utimesSync(oldPath, tenDaysAgo, tenDaysAgo);

  const deletedCount = gcSessions(0);
  t.is(deletedCount, 0);
  t.true(fs.existsSync(oldPath));
});

test.serial('gcSessions returns 0 if ttlDays is negative', (t) => {
  const deletedCount = gcSessions(-5);
  t.is(deletedCount, 0);
});

test.serial('gcSessions gracefully handles missing sessions directory', (t) => {
  const sessionsDir = path.join(tmpConfigDir, 'prompt-scrub', 'sessions');
  if (fs.existsSync(sessionsDir)) {
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  }
  const deletedCount = gcSessions(7);
  t.is(deletedCount, 0);
});

test.serial('gcSessions ignores errors (e.g. concurrent deletion)', (t) => {
  const id = 'gc-test-concurrent';
  const oldPath = getSessionStoragePath(id);
  // Create a directory instead of a file so fs.unlinkSync throws EISDIR
  fs.mkdirSync(oldPath, { recursive: true });
  const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
  fs.utimesSync(oldPath, tenDaysAgo, tenDaysAgo);

  const deletedCount = gcSessions(7);
  t.is(deletedCount, 0);
  t.true(fs.existsSync(oldPath));

  // Cleanup
  fs.rmdirSync(oldPath);
});

// ---------------------------------------------------------------------------
// Encryption-specific tests. These mutate the global config file and the
// PROMPT_SCRUB_KEY env var, so they run as `test.serial` to keep AVA's
// concurrent worker pool from interleaving them.
// ---------------------------------------------------------------------------

test.serial('writeSessionMap encrypts when enabled and decrypts successfully', (t) => {
  const id = 'encrypted-test-1';
  const map = { '«Secret_1»': 'sk-1234' };

  clearCachedEncryptionKey();
  setCachedEncryptionKey('test-key');
  process.env.PROMPT_SCRUB_KEY = 'test-key';

  // Write the global config to enable encryption
  const globalConfigPath = path.join(tmpConfigDir, 'prompt-scrub', 'config.json');
  fs.mkdirSync(path.dirname(globalConfigPath), { recursive: true });
  fs.writeFileSync(globalConfigPath, JSON.stringify({ encryptionEnabled: true }));

  writeSessionMap(id, map);

  // Verify it's encrypted on disk — plaintext must NOT appear anywhere in the file
  const rawData = fs.readFileSync(getSessionStoragePath(id), 'utf-8');
  t.false(rawData.includes('sk-1234'), 'plaintext secret must not appear on disk');
  t.false(rawData.includes('«Secret_1»'), 'plaintext placeholder must not appear on disk');
  const parsed = JSON.parse(rawData);
  t.is(parsed.encrypted, true);

  // Read back via the same key
  const readMap = readSessionMap(id);
  t.deepEqual(readMap, map);

  // Cleanup
  delete process.env.PROMPT_SCRUB_KEY;
  clearCachedEncryptionKey();
  fs.rmSync(globalConfigPath);
});

test.serial('readSessionMap throws SessionDecryptionError when key is wrong or missing', (t) => {
  const id = 'encrypted-test-2';
  const map = { '«Secret_1»': 'sk-1234' };

  setCachedEncryptionKey('test-key');
  process.env.PROMPT_SCRUB_KEY = 'test-key';

  const globalConfigPath = path.join(tmpConfigDir, 'prompt-scrub', 'config.json');
  fs.mkdirSync(path.dirname(globalConfigPath), { recursive: true });
  fs.writeFileSync(globalConfigPath, JSON.stringify({ encryptionEnabled: true }));

  writeSessionMap(id, map);

  // Missing key: clear both cache and env so readSessionMap must ask for one.
  clearCachedEncryptionKey();
  delete process.env.PROMPT_SCRUB_KEY;

  t.throws(() => readSessionMap(id), {
    instanceOf: SessionDecryptionError,
    message: /no key is available/i,
  });

  // Wrong key: re-cache a deliberately wrong key.
  setCachedEncryptionKey('wrong-key');
  process.env.PROMPT_SCRUB_KEY = 'wrong-key';

  t.throws(() => readSessionMap(id), {
    instanceOf: SessionDecryptionError,
    message: /Unable to decrypt session/i,
  });

  // Cleanup
  clearCachedEncryptionKey();
  delete process.env.PROMPT_SCRUB_KEY;
  fs.rmSync(globalConfigPath);
});

test.serial('disabling encryptionEnabled does NOT downgrade an already-encrypted session', (t) => {
  const id = 'encrypted-no-downgrade';

  // First, write the session with encryption on.
  setCachedEncryptionKey('persisted-key');
  process.env.PROMPT_SCRUB_KEY = 'persisted-key';
  const globalConfigPath = path.join(tmpConfigDir, 'prompt-scrub', 'config.json');
  fs.mkdirSync(path.dirname(globalConfigPath), { recursive: true });
  fs.writeFileSync(globalConfigPath, JSON.stringify({ encryptionEnabled: true }));

  writeSessionMap(id, { '«Secret_1»': 'persisted-value' });

  // Now flip the config off and overwrite the same session.
  fs.writeFileSync(globalConfigPath, JSON.stringify({ encryptionEnabled: false }));
  writeSessionMap(id, { '«Secret_1»': 'persisted-value' });

  // The file must still be encrypted — silent downgrade would lose access for
  // users who keep toggling the setting.
  t.true(isSessionEncrypted(id), 'session must remain encrypted after rewrite');
  t.true(fs.readFileSync(getSessionStoragePath(id), 'utf-8').includes('"encrypted": true'));

  // Cleanup
  clearCachedEncryptionKey();
  delete process.env.PROMPT_SCRUB_KEY;
  fs.rmSync(globalConfigPath);
});

test.serial('isSessionEncrypted is true for envelopes and false for plaintext', (t) => {
  setCachedEncryptionKey('iso-key');
  process.env.PROMPT_SCRUB_KEY = 'iso-key';
  const globalConfigPath = path.join(tmpConfigDir, 'prompt-scrub', 'config.json');
  fs.mkdirSync(path.dirname(globalConfigPath), { recursive: true });
  fs.writeFileSync(globalConfigPath, JSON.stringify({ encryptionEnabled: true }));

  writeSessionMap('iso-enc', { '«Secret_1»': 'sk-1' });
  t.true(isSessionEncrypted('iso-enc'));

  fs.writeFileSync(globalConfigPath, JSON.stringify({ encryptionEnabled: false }));
  writeSessionMap('iso-plain', { '«Secret_1»': 'sk-2' });
  t.false(isSessionEncrypted('iso-plain'));

  // Cleanup
  clearCachedEncryptionKey();
  delete process.env.PROMPT_SCRUB_KEY;
  fs.rmSync(globalConfigPath);
});
