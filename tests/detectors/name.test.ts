import test from 'ava';
import { NameDetector } from '../../src/detectors/name.js';

const strictDetector = new NameDetector(true);
const laxDetector = new NameDetector(false);

// --- Lax Mode (Default) Cases ---

test('detects simple proper noun', (t) => {
  const findings = laxDetector.detect('say hello to Alice.');
  t.is(findings.length, 1);
  t.is(findings[0]?.value, 'Alice');
  t.is(findings[0]?.placeholderPrefix, 'Name');
});

test('detects multi-word proper noun', (t) => {
  const findings = laxDetector.detect('say hello to John Doe.');
  t.is(findings.length, 1);
  t.is(findings[0]?.value, 'John Doe');
});

test('detects allowlisted word in lax mode', (t) => {
  const findings = laxDetector.detect('I live in the United States.');
  t.is(findings.length, 1);
  t.is(findings[0]?.value, 'United States');
});

test('detects multiple names', (t) => {
  const findings = laxDetector.detect('Alice and Bob went to London.');
  t.is(findings.length, 3);
  t.is(findings[0]?.value, 'Alice');
  t.is(findings[1]?.value, 'Bob');
  t.is(findings[2]?.value, 'London');
});

// --- Strict Mode Cases ---

test('strict mode skips allowlisted first names', (t) => {
  const findings = strictDetector.detect('John went to the store with Jane.');
  t.is(findings.length, 0); // John and Jane are allowlisted
});

test('strict mode skips allowlisted countries and languages', (t) => {
  const findings = strictDetector.detect('In Canada, people speak English and French.');
  t.is(findings.length, 0);
});

test('strict mode skips allowlisted products', (t) => {
  const findings = strictDetector.detect('Apple and Microsoft are big companies.');
  t.is(findings.length, 0);
});

test('strict mode detects non-allowlisted proper nouns', (t) => {
  const findings = strictDetector.detect('Alice went to Hogwarts.');
  t.is(findings.length, 2);
  t.is(findings[0]?.value, 'Alice');
  t.is(findings[1]?.value, 'Hogwarts');
});

test('strict mode detects multi-word names even if partial match with allowlist', (t) => {
  const findings = strictDetector.detect('say hello to Arthur Doe.');
  t.is(findings.length, 1);
  t.is(findings[0]?.value, 'Arthur Doe');
});

// --- Negative Cases ---

test('does not match lowercase words', (t) => {
  const findings = laxDetector.detect('the quick brown fox');
  t.is(findings.length, 0);
});

test('does not match mid-word capital letters', (t) => {
  const findings = laxDetector.detect('macOS or iPhone');
  t.is(findings.length, 0);
});
