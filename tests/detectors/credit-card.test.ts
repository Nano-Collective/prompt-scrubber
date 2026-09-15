import test from 'ava';
import { CreditCardDetector } from '../../src/detectors/credit-card.js';

const detector = new CreditCardDetector();

// --- Positive Cases (Valid Cards with Luhn Checksum) ---

test('detects valid Visa 16-digit card (spaced and dashed)', (t) => {
  // 4532 0150 0000 0007 is a valid Luhn Visa
  const findings = detector.detect('Payment via 4532-0150-0000-0007 or 4532 0150 0000 0007.');
  t.is(findings.length, 2);
  t.is(findings[0]?.value, '4532-0150-0000-0007');
  t.is(findings[0]?.placeholderPrefix, 'CreditCard');
  t.is(findings[1]?.value, '4532 0150 0000 0007');
});

test('detects valid Mastercard 16-digit card', (t) => {
  // 5105 1051 0510 5100 is valid Luhn Mastercard
  const findings = detector.detect('Mastercard: 5105 1051 0510 5100');
  t.is(findings.length, 1);
  t.is(findings[0]?.value, '5105 1051 0510 5100');
});

test('detects valid American Express 15-digit card (4-6-5 format)', (t) => {
  // 3782 822463 10005 is valid Luhn Amex
  const findings = detector.detect('Amex card: 3782 822463 10005 on file');
  t.is(findings.length, 1);
  t.is(findings[0]?.value, '3782 822463 10005');
});

test('detects valid continuous digits (no delimiters)', (t) => {
  const findings = detector.detect('Card 4532015000000007 charged.');
  t.is(findings.length, 1);
  t.is(findings[0]?.value, '4532015000000007');
});

// --- Span Accuracy ---

test('span accurately reflects slice of text', (t) => {
  const text = 'Card: 4532-0150-0000-0007 is active';
  const findings = detector.detect(text);
  t.is(findings.length, 1);
  const [start, end] = findings[0]!.span;
  t.is(text.slice(start, end), '4532-0150-0000-0007');
});

// --- Negative Cases (False Positives & Luhn Failures) ---

test('rejects card-like number with invalid Luhn checksum', (t) => {
  // Last digit altered from 8 to 9 -> fails Luhn
  const findings = detector.detect('Bad card: 4532 0150 0000 0009');
  t.is(findings.length, 0);
});

test('rejects arbitrary 16-digit numbers (barcodes, serial numbers)', (t) => {
  const findings = detector.detect('Serial: 1234567890123456, Tracking: 9876543210987654');
  t.is(findings.length, 0);
});

test('rejects phone numbers and short numbers', (t) => {
  const findings = detector.detect('Call +1 555 123 4567 or zip 90210');
  t.is(findings.length, 0);
});

test('does not match a Luhn-valid digit run embedded in an identifier', (t) => {
  t.is(detector.detect('Release 10.15.7 build 4532015000000007x').length, 0);
  t.is(detector.detect('ref a4532015000000007').length, 0);
});
