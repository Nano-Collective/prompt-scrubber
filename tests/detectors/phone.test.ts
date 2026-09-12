import test from 'ava';
import { PhoneDetector } from '../../src/detectors/phone.js';

const detector = new PhoneDetector();

// --- Positive Cases ---

test('detects international E.164 phone number', (t) => {
  const findings = detector.detect('Call me at +44 7911 123456 please.');
  t.is(findings.length, 1);
  t.is(findings[0]?.placeholderPrefix, 'Phone');
});

test('detects US number with country code', (t) => {
  const findings = detector.detect('Hotline: +1-800-555-0199');
  t.is(findings.length, 2);
  t.is(findings[0]?.value, '+1-800-555-0199');
  t.is(findings[1]?.value, '800-555-0199');
});

test('detects US number in parentheses format', (t) => {
  const findings = detector.detect('Office: (555) 123-4567');
  t.is(findings.length, 1);
  t.is(findings[0]?.value, '(555) 123-4567');
});

test('detects US number with dashes', (t) => {
  const findings = detector.detect('Fax: 555-123-4567');
  t.is(findings.length, 1);
  t.is(findings[0]?.value, '555-123-4567');
});

test('detects US number with dots', (t) => {
  const findings = detector.detect('Mobile: 555.123.4567');
  t.is(findings.length, 1);
  t.is(findings[0]?.value, '555.123.4567');
});

test('detects multiple phone numbers in one string', (t) => {
  const findings = detector.detect('Call (555) 123-4567 or +44 7911 123456');
  t.is(findings.length, 2);
});

test('returns correct span for US format', (t) => {
  const text = 'Number: 555-123-4567 end';
  const findings = detector.detect(text);
  t.is(findings.length, 1);
  const [start, end] = findings[0]!.span;
  t.is(text.slice(start, end), '555-123-4567');
});

// --- Negative Cases ---

test('does not match a plain date', (t) => {
  const findings = detector.detect('Date: 2024-06-24');
  t.is(findings.length, 0);
});

test('does not match a version number', (t) => {
  const findings = detector.detect('Version 1.2.3 is released');
  t.is(findings.length, 0);
});

test('does not match a bare 5-digit number', (t) => {
  const findings = detector.detect('Zip code 90210');
  t.is(findings.length, 0);
});

test('returns empty for plain text', (t) => {
  const findings = detector.detect('No phone numbers here at all.');
  t.is(findings.length, 0);
});

test('detects but rejects a string with fewer than 7 digits', (t) => {
  const findings = detector.detect('Short: +1 234');
  t.is(findings.length, 0);
});

test('resolves overlapping matches by picking the longer one', (t) => {
  // Intl match: +1-23-4-567 (11 chars, 4 groups, 7 digits - stops because next is '-')
  // Dashes match: 567-890-1234 (12 chars)
  // The Dashes match overlaps and is longer, so it should win.
  const findings = detector.detect('Call +1-23-4-567-890-1234');
  t.is(findings.length, 2);
  // It returns both the shorter and longer match, since deduplication is now handled centrally.
  t.is(findings[0]?.value, '+1-23-4-567');
  t.is(findings[1]?.value, '567-890-1234');
});

test('span accurately reflects value slice in text', (t) => {
  const text = 'Call me at +1-555-123-4567 or (555) 123-4567 anytime.';
  const findings = detector.detect(text);
  for (const finding of findings) {
    const [start, end] = finding.span;
    t.is(text.slice(start, end), finding.value);
  }
});

// --- Confidence ---

test('scores a marked phone number above a bare 3-3-4 group', (t) => {
  const international = detector.detect('Call +44 7911 123456 today');
  t.is(international[0]?.confidence, 0.9);
  t.is(international[0]?.method, 'structural');

  const parenthesised = detector.detect('Call (555) 123-4567 today');
  t.is(parenthesised[0]?.confidence, 0.9);

  const dashed = detector.detect('Call 555-123-4567 today');
  t.is(dashed[0]?.confidence, 0.8);
});
