import test from 'ava';
import {
  DEFAULT_MAX_SESSIONS,
  dropIfEmpty,
  openSession,
  type Sessions,
} from '../../src/proxy/session-store.js';

test('openSession creates a session and returns the same map on the next call', (t) => {
  const sessions: Sessions = new Map();
  const first = openSession(sessions, 'a', 10);
  first['«Email_1»'] = 'x';
  t.is(openSession(sessions, 'a', 10), first);
  t.is(sessions.size, 1);
});

test('openSession marks a session as the most recently used', (t) => {
  const sessions: Sessions = new Map();
  openSession(sessions, 'a', 10);
  openSession(sessions, 'b', 10);
  openSession(sessions, 'c', 10);
  openSession(sessions, 'a', 10);
  t.deepEqual([...sessions.keys()], ['b', 'c', 'a']);
});

test('openSession drops the least recently used sessions past the cap', (t) => {
  const sessions: Sessions = new Map();
  for (const id of ['a', 'b', 'c']) openSession(sessions, id, 3);
  openSession(sessions, 'a', 3);
  openSession(sessions, 'd', 3);
  t.deepEqual([...sessions.keys()], ['c', 'a', 'd']);
});

test('openSession keeps at least the session it was asked for', (t) => {
  const sessions: Sessions = new Map();
  openSession(sessions, 'a', 0);
  openSession(sessions, 'b', -5);
  t.deepEqual([...sessions.keys()], ['b']);
});

test('the default cap is a finite, generous number', (t) => {
  t.true(Number.isInteger(DEFAULT_MAX_SESSIONS));
  t.true(DEFAULT_MAX_SESSIONS >= 100);
});

test('dropIfEmpty forgets only a session with no placeholders', (t) => {
  const sessions: Sessions = new Map();
  const empty = openSession(sessions, 'empty', 10);
  const used = openSession(sessions, 'used', 10);
  used['«Email_1»'] = 'x';

  dropIfEmpty(sessions, 'empty', empty);
  dropIfEmpty(sessions, 'used', used);

  t.false(sessions.has('empty'));
  t.true(sessions.has('used'));
});

test('dropIfEmpty leaves alone a different map stored under the same ID', (t) => {
  const sessions: Sessions = new Map();
  openSession(sessions, 'a', 10);
  dropIfEmpty(sessions, 'a', {});
  t.true(sessions.has('a'));
});
