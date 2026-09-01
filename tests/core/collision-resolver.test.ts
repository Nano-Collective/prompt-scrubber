import test from 'ava';
import { type ResolvableFinding, resolveCollisions } from '../../src/core/collision-resolver.js';
import type { Finding } from '../../src/types/index.js';

function makeFinding(category: string, start: number, end: number, value = 'test'): Finding {
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
  const findings = [makeFinding('Email', 0, 10), makeFinding('Phone', 20, 30)];
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
  const url = makeFinding('Url', 40, 60); // standalone
  const result = resolveCollisions([email, phone, url]);
  t.is(result.length, 2);
  t.is(result[0]?.category, 'Email');
  t.is(result[1]?.category, 'Url');
});

test('handles exactly abutting spans (no overlap)', (t) => {
  const email = makeFinding('Email', 0, 10);
  const phone = makeFinding('Phone', 10, 20);
  const result = resolveCollisions([email, phone]);
  t.is(result.length, 2);
});

test('handles unknown custom detector priority', (t) => {
  const unknown1 = makeFinding('UnknownDetectorA', 0, 10, 'short');
  const unknown2 = makeFinding('UnknownDetectorB', 5, 20, 'much_longer');
  const result = resolveCollisions([unknown1, unknown2]);
  t.is(result.length, 1);
  t.is(result[0]?.category, 'UnknownDetectorB');
});

function makeLocaleFinding(
  category: string,
  start: number,
  end: number,
  value = 'test',
): ResolvableFinding {
  return { ...makeFinding(category, start, end, value), localeScoped: true };
}

test('a locale-scoped finding replaces an equal-priority finding on the same span', (t) => {
  const generic = makeFinding('Address', 0, 20, '10 Downing Street xyz');
  const localeScoped = makeLocaleFinding('Address', 0, 20, 'Downing Street 10 xyz');

  const result = resolveCollisions([generic, localeScoped]);

  t.is(result.length, 1);
  t.is(result[0]?.value, 'Downing Street 10 xyz');
});

test('a locale-scoped finding wins when it redacts more text', (t) => {
  const generic = makeFinding('Address', 5, 15, 'Downing St');
  const localeScoped = makeLocaleFinding('Address', 0, 20, '10 Downing Street xyz');

  const result = resolveCollisions([generic, localeScoped]);

  t.is(result.length, 1);
  t.is(result[0]?.value, '10 Downing Street xyz');
});

test('a locale-scoped finding never narrows an overlapping redaction', (t) => {
  const generic = makeFinding('Address', 0, 20, '10 Downing Street xyz');
  const localeScoped = makeLocaleFinding('Address', 5, 15, 'Downing St');

  // Both orderings must agree: preferring the narrower span would leave
  // characters 0-5 in the clear that the generic finding covered.
  for (const findings of [
    [generic, localeScoped],
    [localeScoped, generic],
  ]) {
    const result = resolveCollisions(findings);
    t.is(result.length, 1);
    t.deepEqual(result[0]?.span, [0, 20]);
  }
});

test('a locale-scoped finding still loses to a higher-priority detector', (t) => {
  const secret = makeFinding('Secret', 0, 10);
  const localeScoped = makeLocaleFinding('Address', 5, 20);

  const result = resolveCollisions([secret, localeScoped]);

  t.is(result.length, 1);
  t.is(result[0]?.category, 'Secret');
});

test('a locale-scoped finding beats a lower-priority overlapping finding', (t) => {
  const name = makeFinding('Name', 0, 20);
  const localeScoped = makeLocaleFinding('Address', 5, 10);

  const result = resolveCollisions([name, localeScoped]);

  t.is(result.length, 1);
  t.is(result[0]?.category, 'Address');
});

test('two locale-scoped findings fall back to the longest-span tie-break', (t) => {
  const short = makeLocaleFinding('Address', 5, 15, 'short');
  const long = makeLocaleFinding('Address', 0, 20, 'much longer value');

  const result = resolveCollisions([short, long]);

  t.is(result.length, 1);
  t.is(result[0]?.value, 'much longer value');
});

test('findings without a locale marker resolve exactly as before', (t) => {
  const findings = [
    makeFinding('Address', 0, 20, '10 Downing Street xyz'),
    makeFinding('Address', 5, 15, 'Downing St'),
  ];

  const result = resolveCollisions(findings);

  t.is(result.length, 1);
  t.is(result[0]?.value, '10 Downing Street xyz');
});

test('locale-scoped findings that do not overlap are all kept', (t) => {
  const a = makeLocaleFinding('Address', 0, 10);
  const b = makeLocaleFinding('Address', 20, 30);

  const result = resolveCollisions([a, b]);

  t.is(result.length, 2);
});
