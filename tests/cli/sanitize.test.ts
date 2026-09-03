import test from 'ava';
import { sanitizeLine } from '../../src/cli/sanitize.js';

test('CSI final bytes in 0x40-0x7E do not eat following content', (t) => {
  t.is(sanitizeLine('\x1b[3~leaked-secret@corp.com'), 'leaked-secret@corp.com');
  t.is(sanitizeLine('\x1b[1}visible@corp.com'), 'visible@corp.com');
  t.is(sanitizeLine('\x1b[3~+1 415-555-1234'), '+1 415-555-1234');
  t.is(sanitizeLine('\x1b[2Jhide-me@corp.com'), 'hide-me@corp.com');
});

test('truncated CSI does not wipe the rest of the line', (t) => {
  t.is(sanitizeLine('\x1b['), '');
  t.is(sanitizeLine('ok\x1b['), 'ok');
  t.is(sanitizeLine('\x1b[3'), '');
});

test('OSC is dropped through BEL', (t) => {
  t.is(sanitizeLine('\x1b]0;secret@corp.com\x07visible'), 'visible');
});

test('tab is kept and DEL is dropped', (t) => {
  t.is(sanitizeLine('a\tb'), 'a\tb');
  t.is(sanitizeLine('pre\x7fleaked-secret@corp.com'), 'preleaked-secret@corp.com');
});
