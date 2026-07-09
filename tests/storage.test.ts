import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'ava';
import {
  deleteSessionMap,
  getSessionStoragePath,
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
});

test('readSessionMap returns {} on missing file', (t) => {
  const result = readSessionMap('non-existent-id');
  t.deepEqual(result, {});
});

test('writeSessionMap creates parent dirs and readSessionMap reads it back', (t) => {
  const id = 'test-write-id';
  const map = { '«Email_1»': 'test@example.com' };

  writeSessionMap(id, map);

  const readMap = readSessionMap(id);
  t.deepEqual(readMap, map);
});

test('writeSessionMap handles JSON parse errors gracefully by renaming corrupt files', (t) => {
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
});

test('deleteSessionMap returns true on hit and false on miss', (t) => {
  const id = 'delete-test-id';
  writeSessionMap(id, { '«Path_1»': '/var/log' });

  const deletedExisting = deleteSessionMap(id);
  t.true(deletedExisting);

  const deletedMissing = deleteSessionMap(id);
  t.false(deletedMissing);
});

test('deleteSessionMap handles unlinkSync error', (t) => {
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

test('listSessions ignores non-.json files', (t) => {
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

test('listSessions returns sessions sorted by most recently modified', async (t) => {
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

test('getSessionStoragePath returns correctly formatted path', (t) => {
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

test('writeSessionMap failure path handles unlinkSync error', (t) => {
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

test('readSessionMap fails to rename corrupt file gracefully', (t) => {
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
