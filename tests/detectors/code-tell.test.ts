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
