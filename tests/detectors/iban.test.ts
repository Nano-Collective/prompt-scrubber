import test from 'ava';
import { IbanDetector } from '../../src/detectors/iban.js';

const detector = new IbanDetector();

// --- Positive Cases (Valid IBANs with MOD-97 Checksum) ---

test('detects valid UK IBAN (formatted with spaces)', (t) => {
  // GB82 WEST 1234 5698 7654 32 is a valid UK IBAN
  const findings = detector.detect('Transfer funds to GB82 WEST 1234 5698 7654 32 immediately.');
  t.is(findings.length, 1);
  t.is(findings[0]?.value, 'GB82 WEST 1234 5698 7654 32');
  t.is(findings[0]?.category, 'Iban');
  t.is(findings[0]?.placeholderPrefix, 'Iban');
});

test('detects valid German IBAN (continuous format)', (t) => {
  // DE89 3704 0044 0532 0130 00
  const findings = detector.detect('DE89370400440532013000 is our bank account.');
  t.is(findings.length, 1);
  t.is(findings[0]?.value, 'DE89370400440532013000');
});

test('detects valid French IBAN', (t) => {
  // FR14 2004 1010 0505 0001 3M02 606
  const findings = detector.detect('French account: FR14 2004 1010 0505 0001 3M02 606');
  t.is(findings.length, 1);
  t.is(findings[0]?.value, 'FR14 2004 1010 0505 0001 3M02 606');
});

test('detects multiple IBANs in text', (t) => {
  const text = 'Accounts: GB82 WEST 1234 5698 7654 32 and DE89370400440532013000';
  const findings = detector.detect(text);
  t.is(findings.length, 2);
});

test('span accurately indexes text slice', (t) => {
  const text = 'IBAN is GB82 WEST 1234 5698 7654 32 for wire';
  const findings = detector.detect(text);
  t.is(findings.length, 1);
  const [start, end] = findings[0]!.span;
  t.is(text.slice(start, end), 'GB82 WEST 1234 5698 7654 32');
});

// --- Negative Cases (MOD-97 Failures & False Positives) ---

test('rejects IBAN with altered check digits (fails MOD-97)', (t) => {
  // GB83 WEST 1234 5698 7654 32 (82 altered to 83)
  const findings = detector.detect('Bad IBAN: GB83 WEST 1234 5698 7654 32');
  t.is(findings.length, 0);
});

test('rejects invalid length or formatting', (t) => {
  const findings = detector.detect(
    'Short GB82 WEST, long GB82 WEST 1234 5698 7654 32 1111 2222 3333 4444',
  );
  t.is(findings.length, 0);
});

test('returns empty for clean text', (t) => {
  const findings = detector.detect('No bank accounts mentioned.');
  t.is(findings.length, 0);
});

test('rejects tokens whose country code does not issue IBANs', (t) => {
  // MOD-97 alone accepts a slice of random uppercase tokens; the country registry
  // rejects them before the checksum is even reached.
  t.is(detector.detect('Build tag ZZ82WEST12345698765432 here').length, 0);
});

test('rejects a valid country code at the wrong length', (t) => {
  // GB IBANs are exactly 22 characters.
  t.is(detector.detect('Ref GB82WEST123456987654321 today').length, 0);
});
