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

test('a narrowed fragment carries an attenuated confidence, not the original', (t) => {
  // The fragment is weaker evidence than the full match that produced it: it
  // only survives because a higher-priority finding contradicted the part
  // that was dropped, not because anything re-confirmed this narrower span.
  const text = 'C:\\app\\cfg.ini owner alice@corp.com';
  const emailStart = text.indexOf('alice@corp.com');
  const overBroadPath: Finding = {
    ...makeFinding('Path', 0, text.length, text),
    confidence: 0.7,
  };
  const email = makeFinding('Email', emailStart, text.length, text.slice(emailStart));

  const result = resolveCollisions([overBroadPath, email]);

  const narrowedPath = result.find((f) => f.category === 'Path');
  t.is(narrowedPath?.value, 'C:\\app\\cfg.ini owner');
  t.is(narrowedPath?.confidence, 0.7 * 0.8);
});

test('a narrowed fragment of a finding with no confidence gains none', (t) => {
  const text = 'C:\\app\\cfg.ini owner alice@corp.com';
  const emailStart = text.indexOf('alice@corp.com');
  const overBroadPath = makeFinding('Path', 0, text.length, text); // no confidence field
  const email = makeFinding('Email', emailStart, text.length, text.slice(emailStart));

  const result = resolveCollisions([overBroadPath, email]);

  const narrowedPath = result.find((f) => f.category === 'Path');
  t.false('confidence' in (narrowedPath ?? {}), 'must not gain a key the loser never had');
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

test('a locale-scoped finding never wins on a partial (non-containing) overlap that covers less', (t) => {
  // generic [0,20] (len 20) vs locale [15,30] (len 15, localeScoped). Neither
  // span contains the other, so this is not the strict-containment case
  // `covers()` guards against on its own - it must fall through to the
  // longest-value tie-break rather than let the locale span win outright,
  // which would expose characters 0-15 that the generic finding redacted.
  const generic = makeFinding('Address', 0, 20, 'x'.repeat(20));
  const locale = makeLocaleFinding('Address', 15, 30, 'x'.repeat(15));

  for (const findings of [
    [generic, locale],
    [locale, generic],
  ]) {
    const result = resolveCollisions(findings);
    t.is(result.length, 1);
    t.deepEqual(result[0]?.span, [0, 20], 'the wider, non-locale finding must win');
  }
});

test('a locale-scoped finding never wins a partial overlap even with a longer value', (t) => {
  // generic [0,20] (len 20) vs locale [15,45] (len 30, localeScoped). The
  // locale finding's value is longer than the generic one's, so the ordinary
  // longest-value tie-break would pick it if the locale branch fell through
  // to it - but the locale span does not cover the generic one, so preferring
  // it would still expose characters 0-15 that the generic finding redacted.
  const generic = makeFinding('Address', 0, 20, 'x'.repeat(20));
  const locale = makeLocaleFinding('Address', 15, 45, 'x'.repeat(30));

  for (const findings of [
    [generic, locale],
    [locale, generic],
  ]) {
    const result = resolveCollisions(findings);
    t.is(result.length, 1);
    t.deepEqual(result[0]?.span, [0, 20], 'the wider, non-locale finding must win');
  }
});

test('a locale-scoped finding wins a partial overlap when it covers strictly more', (t) => {
  // The reverse of the case above: the locale finding's span is a superset of
  // the generic one's, so it legitimately covers more text and should win.
  const generic = makeFinding('Address', 5, 15, 'x'.repeat(10));
  const locale = makeLocaleFinding('Address', 0, 20, 'x'.repeat(20));

  const result = resolveCollisions([generic, locale]);

  t.is(result.length, 1);
  t.true(result[0]?.localeScoped);
  t.deepEqual(result[0]?.span, [0, 20]);
});

test('two different categories at the same default priority do not enter the locale tie-break', (t) => {
  // Both categories are unrecognised, so priorityOf falls through to the same
  // `?? 99` bucket for each - "same priority" is not "same category". A
  // locale-scoped finding from one category must not out-rank an overlapping
  // finding from a genuinely different category just because they share that
  // default bucket; it must fall to the ordinary longest-value tie-break.
  const cpf = makeLocaleFinding('Cpf', 0, 10, 'short');
  const ticket = makeFinding('Ticket', 5, 25, 'a much longer ticket value');

  const result = resolveCollisions([cpf, ticket]);

  t.is(result.length, 1);
  t.is(
    result[0]?.category,
    'Ticket',
    'the longer value wins; category, not localeScoped, decided it',
  );
});
