import test from 'ava';
import { PostalAddressDetector } from '../../src/detectors/postal-address.js';

const detector = new PostalAddressDetector();

// --- Positive Cases ---

test('detects basic street address', (t) => {
  const findings = detector.detect('Meet me at 123 Main Street tomorrow.');
  t.is(findings.length, 1);
  t.is(findings[0]?.value, '123 Main Street');
  t.is(findings[0]?.placeholderPrefix, 'Address');
});

test('detects abbreviated street address', (t) => {
  const findings = detector.detect('My home is 45 Oak Road.');
  t.is(findings.length, 1);
  t.is(findings[0]?.value, '45 Oak Road.');
});

test('detects abbreviated ave with period', (t) => {
  const findings = detector.detect('1600 Pennsylvania Ave. is famous.');
  t.is(findings.length, 1);
  t.is(findings[0]?.value, '1600 Pennsylvania Ave.');
});

test('detects alphanumeric street number', (t) => {
  const findings = detector.detect('Sherlock lived at 221B Baker St in London.');
  t.is(findings.length, 1);
  t.is(findings[0]?.value, '221B Baker St');
});

test('detects multiple addresses', (t) => {
  const findings = detector.detect('From 10 Downing St to 1600 Pennsylvania Ave.');
  t.is(findings.length, 2);
  t.is(findings[0]?.value, '10 Downing St');
  t.is(findings[1]?.value, '1600 Pennsylvania Ave.');
});

// --- Negative Cases ---

test('does not fire on bare numbers', (t) => {
  const findings = detector.detect('I bought 123 apples.');
  t.is(findings.length, 0);
});

test('does not fire on dates', (t) => {
  const findings = detector.detect('The event is on 2024-01-01 today.');
  t.is(findings.length, 0);
});

test('does not fire on version strings', (t) => {
  const findings = detector.detect('Version 1.2.3 released.');
  t.is(findings.length, 0);
});

test('does not fire on plain text', (t) => {
  const findings = detector.detect('I live down the street from here.');
  t.is(findings.length, 0);
});

// --- Confidence ---

test('scores an address as a heuristic match', (t) => {
  const findings = detector.detect('Ship it to 123 Main Street please');
  t.is(findings[0]?.confidence, 0.7);
  t.is(findings[0]?.method, 'heuristic');
});
