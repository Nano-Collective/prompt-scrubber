import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'ava';
import { SessionManager } from '../src/session/session-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const tmpConfigDir = path.join(__dirname, '.tmp-config-sm');

test.before(() => {
  // PROMPT_SCRUB_CONFIG_DIR is honored on every platform; XDG_CONFIG_HOME is only
  // read on Linux, so it does not isolate storage on macOS/Windows (which caused
  // tests to read/write the user's real session dir).
  process.env.PROMPT_SCRUB_CONFIG_DIR = tmpConfigDir;
  if (fs.existsSync(tmpConfigDir)) {
    fs.rmSync(tmpConfigDir, { recursive: true, force: true });
  }
});

test.after.always(() => {
  if (fs.existsSync(tmpConfigDir)) {
    fs.rmSync(tmpConfigDir, { recursive: true, force: true });
  }
});

test('SessionManager initializes new session', (t) => {
  const manager = new SessionManager();
  t.truthy(manager.getSessionId());
  t.deepEqual(manager.getMap(), {});
});

test('SessionManager resumes existing session', (t) => {
  const manager1 = new SessionManager();
  manager1.createPlaceholder('Email', 'test@example.com');
  manager1.save();

  const manager2 = new SessionManager(manager1.getSessionId());
  t.deepEqual(manager2.getMap(), { '«Email_1»': 'test@example.com' });
});

test('createPlaceholder is idempotent on duplicate originalValue', (t) => {
  const manager = new SessionManager();
  const p1 = manager.createPlaceholder('Email', 'bob@example.com');
  const p2 = manager.createPlaceholder('Email', 'bob@example.com');

  t.is(p1, '«Email_1»');
  t.is(p2, '«Email_1»');
});

test('rebuildCategoryCounts handles gaps and correctly infers next index', (t) => {
  const manager = new SessionManager();

  // Manually insert placeholders with gaps
  const map = manager.getMap();
  map['«Email_1»'] = 'a@test.com';
  map['«Email_3»'] = 'b@test.com';

  // Force a rebuild by re-instantiating with the saved state
  manager.save();
  const resumedManager = new SessionManager(manager.getSessionId());

  const nextEmail = resumedManager.createPlaceholder('Email', 'c@test.com');
  t.is(nextEmail, '«Email_4»'); // The highest index was 3, so next should be 4
});

test('regression: overlapping prefixes do not cause collision', (t) => {
  const manager = new SessionManager();
  const map = manager.getMap();

  // Populate with overlapping, similarly named prefixes
  map['«Email_2»'] = 'email2@test.com';
  map['«EMail_2»'] = 'email_weird@test.com';
  map['«URL_1»'] = 'https://test.com';

  manager.save();

  const resumed = new SessionManager(manager.getSessionId());

  const nextEmail = resumed.createPlaceholder('Email', 'email3@test.com');
  const nextEMail = resumed.createPlaceholder('EMail', 'email_weird3@test.com');
  const nextURL = resumed.createPlaceholder('URL', 'https://test.com/2');

  t.is(nextEmail, '«Email_3»');
  t.is(nextEMail, '«EMail_3»');
  t.is(nextURL, '«URL_2»');
});

test('destroy removes the session and clears memory', (t) => {
  const manager = new SessionManager();
  manager.createPlaceholder('Secret', 'sk-xyz');
  manager.save();

  t.truthy(manager.getMap()['«Secret_1»']);
  manager.destroy();

  t.deepEqual(manager.getMap(), {});

  const sessions = SessionManager.listAll();
  t.false(sessions.some((s) => s.id === manager.getSessionId()));
});

test('getMap returns reference to in-memory map', (t) => {
  const manager = new SessionManager();
  manager.createPlaceholder('Email', 'x@y.com');
  const map = manager.getMap();
  t.is(map['«Email_1»'], 'x@y.com');
});

test('save writes map to disk', (t) => {
  const manager = new SessionManager();
  manager.createPlaceholder('Secret', '123');
  manager.save();
  const map = manager.getMap();
  t.is(map['«Secret_1»'], '123');
});

test('rebuildCategoryCounts ignores invalid placeholders and handles out-of-order indexes', (t) => {
  const manager = new SessionManager();
  const map = manager.getMap();
  map['«Email_2»'] = 'b@test.com';
  map['«Email_1»'] = 'a@test.com'; // out of order, triggers index < counts[category]
  map['InvalidPlaceholder'] = 'invalid'; // triggers match == null
  map['Email_'] = 'invalid2'; // triggers match == null

  manager.save();
  const resumed = new SessionManager(manager.getSessionId());
  const next = resumed.createPlaceholder('Email', 'c@test.com');
  t.is(next, '«Email_3»');
});
