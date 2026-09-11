import test from 'ava';
import { CodeTellDetector } from '../../src/detectors/code-tell.js';

test('no-op when instantiated without terms', (t) => {
  const detector = new CodeTellDetector();
  const findings = detector.detect('MyClass is a private class.');
  t.is(findings.length, 0);
});

test('no-op when instantiated with empty terms', (t) => {
  const detector = new CodeTellDetector(['', '   ']);
  const findings = detector.detect('MyClass is a private class.');
  t.is(findings.length, 0);
});

test('detects configured terms', (t) => {
  const detector = new CodeTellDetector(['MyClass', 'internalVariable']);
  const findings = detector.detect('The MyClass uses internalVariable for state.');
  t.is(findings.length, 2);
  t.is(findings[0]?.value, 'MyClass');
  t.is(findings[0]?.placeholderPrefix, 'CodeTell');
  t.is(findings[1]?.value, 'internalVariable');
});

test('does not match partial tokens', (t) => {
  const detector = new CodeTellDetector(['Class', 'var']);
  const findings = detector.detect('MyClass uses a variable.');
  t.is(findings.length, 0);
});

test('matches identifiers even if adjacent to non-identifier symbols', (t) => {
  const detector = new CodeTellDetector(['MyClass']);
  const findings = detector.detect('new MyClass();');
  t.is(findings.length, 1);
  t.is(findings[0]?.value, 'MyClass');
});

test('escapes regex metacharacters in configured terms', (t) => {
  const detector = new CodeTellDetector(['foo.bar', '$cache', '__internal__']);

  let findings = detector.detect('fooXbar');
  t.is(findings.length, 0);

  findings = detector.detect('const c = foo.bar + $cache - __internal__;');
  t.is(findings.length, 3);
  t.is(findings[0]?.value, 'foo.bar');
  t.is(findings[1]?.value, '$cache');
  t.is(findings[2]?.value, '__internal__');
});

test('prioritizes longer overlapping terms', (t) => {
  const detector = new CodeTellDetector(['foo', 'foo.bar']);
  const findings = detector.detect('Call foo.bar()');
  t.is(findings.length, 1);
  t.is(findings[0]?.value, 'foo.bar');
});

// --- Confidence ---

test('scores a user-enumerated term as a user-defined match', (t) => {
  const detector = new CodeTellDetector(['MyClass']);
  const findings = detector.detect('MyClass is a private class.');
  t.is(findings[0]?.confidence, 0.95);
  t.is(findings[0]?.method, 'user-defined');
});

test('drops terms longer than MAX_TERM_LENGTH and reports them in diagnostics', (t) => {
  const oversized = 'a'.repeat(200);
  const detector = new CodeTellDetector(['fine', oversized, 'also-fine']);
  t.deepEqual(detector.getDiagnostics().oversized, [oversized]);
  // The accepted terms still match.
  const findings = detector.detect('fine also-fine');
  t.is(findings.length, 2);
});

test('caps terms at MAX_TERM_COUNT and reports the overflow in diagnostics', (t) => {
  const terms = Array.from({ length: 100 }, (_, i) => `term_${i}`);
  const detector = new CodeTellDetector(terms);
  const diag = detector.getDiagnostics();
  t.is(diag.overflowed.length, 100 - 64);
  // Every overflowed term is one of the ones we dropped past the cap.
  for (const dropped of diag.overflowed) {
    t.true(terms.includes(dropped));
  }
  // The first 64 accepted terms still match.
  const findings = detector.detect('term_0 term_63');
  t.is(findings.length, 2);
});
