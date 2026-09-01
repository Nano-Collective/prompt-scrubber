import test from 'ava';
import { SsnDetector } from '../../src/detectors/ssn.js';

const detector = new SsnDetector();

// --- Positive Cases ---

test('detects valid formatted SSN with hyphens', (t) => {
  const findings = detector.detect('Employee SSN is 123-45-6789.');
  t.is(findings.length, 1);
  t.is(findings[0]?.value, '123-45-6789');
  t.is(findings[0]?.category, 'Ssn');
  t.is(findings[0]?.placeholderPrefix, 'Ssn');
});

test('detects valid SSN with spaces', (t) => {
  const findings = detector.detect('Tax ID: 456 78 9012 on record');
  t.is(findings.length, 1);
  t.is(findings[0]?.value, '456 78 9012');
});

test('detects valid continuous SSN (no delimiters)', (t) => {
  const findings = detector.detect('SSN: 219456789');
  t.is(findings.length, 1);
  t.is(findings[0]?.value, '219456789');
});

test('detects multiple SSNs in text', (t) => {
  const findings = detector.detect(
    'First: 123-45-6789, Second: 987-65-4321 is invalid, Third: 321-54-9876',
  );
  // 987 is invalid (starts with 9xx)
  t.is(findings.length, 2);
  t.is(findings[0]?.value, '123-45-6789');
  t.is(findings[1]?.value, '321-54-9876');
});

test('span accurately indexes text slice', (t) => {
  const text = 'Lookup 123-45-6789 in database';
  const findings = detector.detect(text);
  t.is(findings.length, 1);
  const [start, end] = findings[0]!.span;
  t.is(text.slice(start, end), '123-45-6789');
});

// --- Negative Cases & SSA Structural Validation ---

test('rejects SSN with invalid Area 000', (t) => {
  const findings = detector.detect('Invalid: 000-12-3456');
  t.is(findings.length, 0);
});

test('rejects SSN with invalid Area 666', (t) => {
  const findings = detector.detect('Invalid: 666-12-3456');
  t.is(findings.length, 0);
});

test('rejects SSN with invalid Area in 900-999 range', (t) => {
  const findings = detector.detect('Invalid: 900-12-3456, 950-12-3456, 999-12-3456');
  t.is(findings.length, 0);
});

test('rejects SSN with invalid Group 00', (t) => {
  const findings = detector.detect('Invalid: 123-00-4567');
  t.is(findings.length, 0);
});

test('rejects SSN with invalid Serial 0000', (t) => {
  const findings = detector.detect('Invalid: 123-45-0000');
  t.is(findings.length, 0);
});

test('rejects bare 9-digit runs without an SSN label', (t) => {
  t.is(detector.detect('Order number 123456789 shipped.').length, 0);
  t.is(detector.detect('Error code 402551234 returned.').length, 0);
  t.is(detector.detect('Invoice 987654321 is overdue').length, 0);
});

test('rejects space-separated digit groups without an SSN label', (t) => {
  t.is(detector.detect('qty 100 20 3000 units').length, 0);
});

test('span excludes the label on a contextual match', (t) => {
  const text = 'Social security number 219456789 on file';
  const findings = detector.detect(text);
  t.is(findings.length, 1);
  const [start, end] = findings[0]!.span;
  t.is(text.slice(start, end), '219456789');
});

test('rejects dates and phone numbers', (t) => {
  const findings = detector.detect('Date 2026-08-30 or phone 555-123-4567');
  t.is(findings.length, 0);
});
