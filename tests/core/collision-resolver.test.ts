import test from 'ava';
import { resolveCollisions } from '../../src/core/collision-resolver.js';
import type { Finding } from '../../src/types/index.js';

function makeFinding(
  category: string,
  start: number,
  end: number,
  value = 'test',
): Finding {
  return {
    category,
    span: [start, end],
    value,
    placeholderPrefix: category,
  };
}

test('returns empty array for empty input', (t) => {
  t.deepEqual(resolveCollisions([]), []);
});

test('accepts two non-overlapping findings', (t) => {
  const findings = [
    makeFinding('Email', 0, 10),
    makeFinding('Phone', 20, 30),
  ];
  const result = resolveCollisions(findings);
  t.is(result.length, 2);
  t.is(result[0]?.category, 'Email');
  t.is(result[1]?.category, 'Phone');
});

test('output is sorted by start position ascending', (t) => {
  const findings = [
    makeFinding('Phone', 50, 60),
    makeFinding('Email', 0, 10),
    makeFinding('Url', 20, 30),
  ];
  const result = resolveCollisions(findings);
  t.is(result.length, 3);
  t.is(result[0]?.span[0], 0);
  t.is(result[1]?.span[0], 20);
  t.is(result[2]?.span[0], 50);
});

test('higher-priority detector wins on overlap (Secret beats Email)', (t) => {
  const email = makeFinding('Email', 5, 25, 'user@example.com');
  const secret = makeFinding('Secret', 5, 25, 'user@example.com');
  const result = resolveCollisions([email, secret]);
  t.is(result.length, 1);
  t.is(result[0]?.category, 'Secret');
});

test('higher-priority detector wins on overlap (Email beats Phone)', (t) => {
  const phone = makeFinding('Phone', 0, 20);
  const email = makeFinding('Email', 0, 20);
  const result = resolveCollisions([phone, email]);
  t.is(result.length, 1);
  t.is(result[0]?.category, 'Email');
});

test('on equal priority, longer span wins', (t) => {
  // Two custom findings with no named detector — both fall to priority 99
  const short = makeFinding('Custom', 0, 10, 'shortval');
  const long = makeFinding('Custom', 0, 20, 'muchlongervalue!!!');
  const result = resolveCollisions([short, long]);
  t.is(result.length, 1);
  t.is(result[0]?.value, 'muchlongervalue!!!');
});

test('partial overlap: higher-priority candidate replaces lower-priority accepted', (t) => {
  // Phone accepted first (lower priority), then Email partially overlaps and should win
  const phone = makeFinding('Phone', 0, 15);
  const email = makeFinding('Email', 10, 25);
  const result = resolveCollisions([phone, email]);
  t.is(result.length, 1);
  t.is(result[0]?.category, 'Email');
});

test('three findings: two overlap, one standalone', (t) => {
  const email = makeFinding('Email', 0, 20);
  const phone = makeFinding('Phone', 10, 25); // overlaps with email, email wins
  const url = makeFinding('Url', 40, 60);     // standalone
  const result = resolveCollisions([email, phone, url]);
  t.is(result.length, 2);
  t.is(result[0]?.category, 'Email');
  t.is(result[1]?.category, 'Url');
});
