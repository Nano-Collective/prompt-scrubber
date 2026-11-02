import test from 'ava';
import { rehydrateText } from '../../src/core/rehydrate.js';
import { scrub } from '../../src/core/scrub.js';
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

test('detects internationalised addresses', (t) => {
  const findings = detector.detect('Write to josé@exämple.com or 李雷@例子.中国 today');
  t.deepEqual(
    findings.map((f) => f.value),
    ['josé@exämple.com', '李雷@例子.中国'],
  );
});

test('still matches a local part that starts with a hyphen or plus', (t) => {
  t.is(detector.detect('mail -lead@example.com now')[0]?.value, '-lead@example.com');
  t.is(detector.detect('mail +tag@example.com now')[0]?.value, '+tag@example.com');
});

test('scans long runs of local-part characters in linear time', (t) => {
  for (const run of ['-', '+', '%', '.-', 'a-']) {
    const input = run.repeat(100_000 / run.length);
    const start = Date.now();
    t.is(detector.detect(input).length, 0);
    t.true(Date.now() - start < 1000, `${JSON.stringify(run)} run took ${Date.now() - start}ms`);
  }
});

test('finds an address that is followed by an underscore', (t) => {
  for (const [text, address] of [
    ['see alice@example.com_backup.zip', 'alice@example.com'],
    ['mail alice@example.com_', 'alice@example.com'],
    ['mail a@b.co.uk_old', 'a@b.co.uk'],
  ] as const) {
    const findings = detector.detect(text);
    t.is(findings.length, 1, text);
    t.is(findings[0]?.value, address, text);
    const [start, end] = findings[0]!.span;
    t.is(text.slice(start, end), address, text);
  }
  // A digit or a further label right after the top-level label still means no address.
  t.is(detector.detect('alice@example.com2').length, 0);
});

test('an address followed by an underscore is redacted next to another detector', (t) => {
  for (const [text, scrubbed] of [
    ['gw 192.168.10.25_old mail bob@example.com', 'gw «IpAddress_1»_old mail «Email_1»'],
    ['alice@example.com_old 192.168.10.25_old', '«Email_1»_old «IpAddress_1»_old'],
    ['see alice@example.com_old and https://example.com/status', 'see «Email_1»_old and «Url_1»'],
    ['alice@example.com_old /home/alice/notes.txt', '«Email_1»_old «Path_1»'],
    [String.raw`alice@example.com_old C:\Users\alice\notes.txt`, '«Email_1»_old «Path_1»'],
    [String.raw`C:\Users\alice\notes.txt alice@example.com_old`, '«Path_1» «Email_1»_old'],
  ] as const) {
    const result = scrub({ content: text, sessionMap: {} });
    t.is(result.scrubbedContent, scrubbed, text);
    t.is(rehydrateText(result.scrubbedContent, result.sessionMap).content, text);
  }
});

test('an address followed by an underscore inside a URL is split out whole', (t) => {
  const text = 'https://example.com/x?mail=alice@example.com_old';
  const result = scrub({ content: text, sessionMap: {} });
  const out = String(result.scrubbedContent);
  t.false(out.includes('alice'), out);
  t.is(out.match(/«Email_\d»/g)?.length, 1, out);
  t.is(rehydrateText(result.scrubbedContent, result.sessionMap).content, text);
});

test('many addresses followed by an underscore scan in linear time', (t) => {
  const start = Date.now();
  t.is(detector.detect('a@b.cc_'.repeat(30_000)).length, 15_000);
  t.true(Date.now() - start < 1000, `took ${Date.now() - start}ms`);
});

test('many addresses with an unfinished domain scan in linear time', (t) => {
  const start = Date.now();
  t.deepEqual(detector.detect('a@a.'.repeat(25_000)), []);
  t.deepEqual(detector.detect('a@'.repeat(50_000)), []);
  t.true(Date.now() - start < 1000, `took ${Date.now() - start}ms`);
});

test('detects an address at the end of a sentence', (t) => {
  t.is(detector.detect('Contact alice@example.com.')[0]?.value, 'alice@example.com');
  t.is(detector.detect('Mail bob@example.com. Then call.')[0]?.value, 'bob@example.com');
  t.is(detector.detect('Contact alice@example.co.uk.')[0]?.value, 'alice@example.co.uk');
  t.is(detector.detect('Write to alice@example.com...')[0]?.value, 'alice@example.com');
});

test('the span of an address followed by a full stop excludes the full stop', (t) => {
  const text = 'Contact alice@example.com.';
  const [start, end] = detector.detect(text)[0]!.span;
  t.is(text.slice(start, end), 'alice@example.com');
});

test('still skips a domain that continues past its top-level label', (t) => {
  t.is(detector.detect('a@b.com.x').length, 0);
});

test('an address with no completing domain does not stall the scan', (t) => {
  for (const input of [
    `a@${'-'.repeat(100_000)}`,
    `a@${'a-'.repeat(50_000)}`,
    `a@a.${'b-'.repeat(50_000)}`,
    `a@${'a.a-'.repeat(25_000)}`,
  ]) {
    const start = Date.now();
    t.deepEqual(detector.detect(input), []);
    t.true(Date.now() - start < 1000, `took ${Date.now() - start}ms`);
  }
  t.is(detector.detect(`${'-'.repeat(50_000)} real@example.com`)[0]?.value, 'real@example.com');
});
