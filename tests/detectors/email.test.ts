import test from 'ava';
import { EmailDetector } from '../../src/detectors/email.js';

const detector = new EmailDetector();

// --- Positive Cases ---

test('detects a basic email address', (t) => {
  const findings = detector.detect('Contact us at hello@example.com today.');
  t.is(findings.length, 1);
  t.is(findings[0]?.value, 'hello@example.com');
  t.is(findings[0]?.placeholderPrefix, 'Email');
});

test('detects multiple emails in a single string', (t) => {
  const findings = detector.detect('Send to alice@foo.com and bob@bar.org');
  t.is(findings.length, 2);
  t.is(findings[0]?.value, 'alice@foo.com');
  t.is(findings[1]?.value, 'bob@bar.org');
});

test('detects email with plus-addressing', (t) => {
  const findings = detector.detect('Reply to user+tag@example.com');
  t.is(findings.length, 1);
  t.is(findings[0]?.value, 'user+tag@example.com');
});

test('detects email with subdomain', (t) => {
  const findings = detector.detect('contact@mail.company.co.uk is the address');
  t.is(findings.length, 1);
  t.is(findings[0]?.value, 'contact@mail.company.co.uk');
});

test('detects email at start of string', (t) => {
  const findings = detector.detect('akram@example.com is my email');
  t.is(findings.length, 1);
  t.is(findings[0]?.value, 'akram@example.com');
});

test('returns correct span offsets', (t) => {
  const text = 'Email: test@example.com here';
  const findings = detector.detect(text);
  t.is(findings.length, 1);
  const [start, end] = findings[0]!.span;
  t.is(text.slice(start, end), 'test@example.com');
});

// --- Negative Cases ---

test('does not match a bare @username handle', (t) => {
  const findings = detector.detect('Follow @akramcodez on Twitter');
  t.is(findings.length, 0);
});

test('does not match localhost email (no dot in domain)', (t) => {
  const findings = detector.detect('admin@localhost is internal');
  t.is(findings.length, 0);
});

test('does not match an email longer than 254 chars', (t) => {
  const longLocal = 'a'.repeat(250);
  const findings = detector.detect(`${longLocal}@example.com`);
  t.is(findings.length, 0);
});

test('returns empty array for plain text', (t) => {
  const findings = detector.detect('This is just a normal sentence with no email.');
  t.is(findings.length, 0);
});

// --- Confidence ---

test('scores a matched address as a high-confidence exact pattern', (t) => {
  const findings = detector.detect('Contact user@example.com');
  t.is(findings[0]?.confidence, 0.95);
  t.is(findings[0]?.method, 'exact-pattern');
});
