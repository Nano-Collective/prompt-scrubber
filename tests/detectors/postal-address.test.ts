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

test('does not treat a numbered sentence ending in st as an address', (t) => {
  const findings = detector.detect(
    'There are 42 things you should consider when walking down the st.',
  );
  t.is(findings.length, 0);
});

// --- Confidence ---

test('scores an address as a heuristic match', (t) => {
  const findings = detector.detect('Ship it to 123 Main Street please');
  t.is(findings[0]?.confidence, 0.7);
  t.is(findings[0]?.method, 'heuristic');
});

test('includes a compass direction after the street suffix', (t) => {
  const findings = detector.detect('Visit 1600 Pennsylvania Ave NW today');
  t.is(findings[0]?.value, '1600 Pennsylvania Ave NW');
});

test('includes city, state and ZIP when a ZIP code follows', (t) => {
  t.is(
    detector.detect('1600 Pennsylvania Ave NW, Washington, DC 20500')[0]?.value,
    '1600 Pennsylvania Ave NW, Washington, DC 20500',
  );
  t.is(
    detector.detect('Send to 123 Main St Apt 4B, Springfield, IL 62704-1234 please')[0]?.value,
    '123 Main St Apt 4B, Springfield, IL 62704-1234',
  );
  t.is(
    detector.detect('500 Market St Suite 300, San Francisco, CA 94105.')[0]?.value,
    '500 Market St Suite 300, San Francisco, CA 94105',
  );
});

test('does not read prose after the street as a city and state', (t) => {
  t.is(detector.detect('Go to 5 Church St, then go on')[0]?.value, '5 Church St');
  t.is(detector.detect('221B Baker St, London')[0]?.value, '221B Baker St');
  t.is(detector.detect('I live at 42 Elm Street e.g. near the park')[0]?.value, '42 Elm Street');
  t.is(detector.detect('99 Broad St unit tests pass')[0]?.value, '99 Broad St');
});

test('scans repeated address fragments in linear time', (t) => {
  const start = Date.now();
  detector.detect('Main St, '.repeat(20_000));
  detector.detect(`${'1 '.repeat(20_000)}Main St`);
  t.true(Date.now() - start < 1000);
});
