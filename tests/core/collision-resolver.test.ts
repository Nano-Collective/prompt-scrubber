import test from 'ava';
import { resolveCollisions } from '../../src/core/collision-resolver.js';
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

// A loser is only narrowed when its value lines up with its span, so these use
// real text rather than the default placeholder value.

test('a losing finding is narrowed to the part the winner does not cover', (t) => {
  const text = 'C:\\app\\cfg.ini owner alice@corp.com';
  const emailStart = text.indexOf('alice@corp.com');
  const overBroadPath = makeFinding('Path', 0, text.length, text);
  const email = makeFinding('Email', emailStart, text.length, text.slice(emailStart));

  const result = resolveCollisions([overBroadPath, email]);

  t.is(result.length, 2);
  t.is(result[0]?.value, 'C:\\app\\cfg.ini owner');
  t.is(result[1]?.value, 'alice@corp.com');
});

test('a winner inside the loser keeps the loser on both sides', (t) => {
  const text = 'aaaa BBBB cccc';
  const wide = makeFinding('Path', 0, text.length, text);
  const inner = makeFinding('Secret', 5, 9, 'BBBB');

  const result = resolveCollisions([wide, inner]);

  t.deepEqual(
    result.map((f) => f.value),
    ['aaaa', 'BBBB', 'cccc'],
  );
});

test('a losing finding of the same category is dropped rather than narrowed', (t) => {
  // Rival readings of one entity — the leftover "10" must not become an Address
  const text = '10 Downing St, London';
  const short = makeFinding('Address', 0, 13, text.slice(0, 13));
  const long = makeFinding('Address', 3, text.length, text.slice(3));

  const result = resolveCollisions([short, long]);

  t.is(result.length, 1);
  t.is(result[0]?.value, 'Downing St, London');
});

test('output is pairwise non-overlapping', (t) => {
  // scrub replaces placeholders right-to-left by span, which is only correct
  // while the resolved findings do not overlap. Narrowing adds findings rather
  // than only filtering them, so assert the invariant directly over a spread of
  // shapes: nested, staggered, abutting, identical and same-category.
  const text = 'aaaa BBBB cccc dddd eeee ffff gggg hhhh';
  const slice = (start: number, end: number) => text.slice(start, end);
  const cases: Finding[][] = [
    [makeFinding('Path', 0, 24, slice(0, 24)), makeFinding('Secret', 5, 9, slice(5, 9))],
    [
      makeFinding('Path', 0, 19, slice(0, 19)),
      makeFinding('Email', 5, 14, slice(5, 14)),
      makeFinding('Secret', 10, 24, slice(10, 24)),
    ],
    [
      makeFinding('Path', 0, 29, slice(0, 29)),
      makeFinding('Secret', 5, 9, slice(5, 9)),
      makeFinding('Email', 15, 19, slice(15, 19)),
      makeFinding('Phone', 25, 29, slice(25, 29)),
    ],
    [makeFinding('Address', 0, 13, slice(0, 13)), makeFinding('Address', 3, 24, slice(3, 24))],
    [makeFinding('Url', 0, 10, slice(0, 10)), makeFinding('Url', 0, 10, slice(0, 10))],
    [makeFinding('Name', 4, 9, slice(4, 9)), makeFinding('Phone', 9, 14, slice(9, 14))],
  ];

  for (const findings of cases) {
    const result = resolveCollisions(findings);
    for (let i = 1; i < result.length; i++) {
      const prev = result[i - 1]!;
      const curr = result[i]!;
      t.true(
        prev.span[1] <= curr.span[0],
        `overlap between ${JSON.stringify(prev.span)} and ${JSON.stringify(curr.span)}`,
      );
    }
    // Every surviving finding must still describe the text under its own span.
    for (const finding of result) {
      t.is(text.slice(finding.span[0], finding.span[1]), finding.value);
    }
  }
});

test('handles unknown custom detector priority', (t) => {
  const unknown1 = makeFinding('UnknownDetectorA', 0, 10, 'short');
  const unknown2 = makeFinding('UnknownDetectorB', 5, 20, 'much_longer');
  const result = resolveCollisions([unknown1, unknown2]);
  t.is(result.length, 1);
  t.is(result[0]?.category, 'UnknownDetectorB');
});
