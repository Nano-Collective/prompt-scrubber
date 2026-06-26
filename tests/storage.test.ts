import test from 'ava';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  readSessionMap,
  writeSessionMap,
  deleteSessionMap,
  listSessions,
  getSessionStoragePath,
} from '../src/session/storage.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const tmpConfigDir = path.join(__dirname, '.tmp-config');

test.before(() => {
  // Override XDG_CONFIG_HOME to write to a local temp folder instead of the user's real config
  process.env.XDG_CONFIG_HOME = tmpConfigDir;

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
  const map = { Email_1: 'test@example.com' };

  writeSessionMap(id, map);

  const readMap = readSessionMap(id);
  t.deepEqual(readMap, map);
});

test('writeSessionMap handles JSON parse errors gracefully by renaming corrupt files', (t) => {
  const id = 'corrupt-test-id';
  const map = { Secret_1: 'sk-1234' };

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
  writeSessionMap(id, { Path_1: '/var/log' });

  const deletedExisting = deleteSessionMap(id);
  t.true(deletedExisting);

  const deletedMissing = deleteSessionMap(id);
  t.false(deletedMissing);
});

test('listSessions ignores non-.json files', (t) => {
  const id = 'list-test-id';
  writeSessionMap(id, { Phone_1: '555-1234' });

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

  writeSessionMap(id1, { Email_1: 'a@b.com' });
  // Need a small delay so mtime is strictly greater
  await new Promise((r) => setTimeout(r, 10));
  writeSessionMap(id2, { Email_1: 'c@d.com' });

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
