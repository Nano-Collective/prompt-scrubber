import test from 'ava';
import { UrlDetector } from '../../src/detectors/url.js';

const detector = new UrlDetector();

// --- Positive Cases ---

test('detects a basic https URL', (t) => {
  const findings = detector.detect('Visit https://example.com for details.');
  t.is(findings.length, 1);
  t.is(findings[0]?.value, 'https://example.com');
  t.is(findings[0]?.placeholderPrefix, 'Url');
});

test('detects a http URL', (t) => {
  const findings = detector.detect('Old site: http://example.com/page');
  t.is(findings.length, 1);
  t.is(findings[0]?.value, 'http://example.com/page');
});

test('detects URL with path and query string', (t) => {
  const findings = detector.detect('API: https://api.example.com/v1/users?limit=10&offset=0');
  t.is(findings.length, 1);
  t.is(findings[0]?.value, 'https://api.example.com/v1/users?limit=10&offset=0');
});

test('detects multiple URLs in one string', (t) => {
  const findings = detector.detect('See https://foo.com and https://bar.com for more.');
  t.is(findings.length, 2);
});

test('detects bare API endpoint (no scheme)', (t) => {
  const findings = detector.detect('Endpoint: api.example.com/v2/predict');
  t.is(findings.length, 1);
  t.is(findings[0]?.value, 'api.example.com/v2/predict');
});

test('does not double-match a full URL as both full and bare', (t) => {
  const findings = detector.detect('Call https://api.example.com/v1/predict');
  t.is(findings.length, 1);
});

test('handles bare API endpoint at start of string', (t) => {
  const findings = detector.detect('api.example.com/v1/test is the endpoint');
  t.is(findings.length, 1);
  t.is(findings[0]?.value, 'api.example.com/v1/test');
});

test('handles URL ending with trailing punctuation', (t) => {
  const findings = detector.detect('Visit https://example.com/path.');
  t.is(findings.length, 1);
  t.is(findings[0]?.value, 'https://example.com/path.');
});

test('returns correct span for a URL', (t) => {
  const text = 'Go to https://example.com now';
  const findings = detector.detect(text);
  t.is(findings.length, 1);
  const [start, end] = findings[0]!.span;
  t.is(text.slice(start, end), 'https://example.com');
});

// --- Negative Cases ---

test('does not match a bare domain without a path', (t) => {
  const findings = detector.detect('Visit example.com for info.');
  t.is(findings.length, 0);
});

test('does not match a plain word', (t) => {
  const findings = detector.detect('This is a normal sentence.');
  t.is(findings.length, 0);
});

test('does not match an email as a URL', (t) => {
  const findings = detector.detect('Email me at hello@test.example.com');
  t.is(findings.length, 0);
});

test('skips bare API match if it is already covered by a full URL match', (t) => {
  // FULL_URL_REGEX matches "https://(api.example.com/v1/users)"
  // BARE_API_REGEX will match "api.example.com/v1/users)" because it's preceded by '(' which is not a slash/word char.
  // The bare match should be skipped because it falls within the span of the full match.
  const findings = detector.detect('Visit https://(api.example.com/v1/users)');
  t.is(findings.length, 1);
  t.is(findings[0]?.value, 'https://(api.example.com/v1/users)');
});

// --- Allowlist Cases ---

test('skips full URL when host is allowlisted exactly', (t) => {
  const allowlistDetector = new UrlDetector(['example.com']);
  const findings = allowlistDetector.detect('Visit https://example.com/path');
  t.is(findings.length, 0);
});

test('skips bare API URL when host is allowlisted exactly', (t) => {
  const allowlistDetector = new UrlDetector(['api.example.com']);
  const findings = allowlistDetector.detect('Endpoint: api.example.com/v1/predict');
  t.is(findings.length, 0);
});

test('skips URL when host is a subdomain of an allowlisted domain', (t) => {
  const allowlistDetector = new UrlDetector(['example.com']);
  const findings = allowlistDetector.detect('Visit https://api.example.com/v1');
  t.is(findings.length, 0);
});

test('detects URL when host is NOT in allowlist', (t) => {
  const allowlistDetector = new UrlDetector(['example.com']);
  const findings = allowlistDetector.detect('Visit https://otherdomain.com/path');
  t.is(findings.length, 1);
  t.is(findings[0]?.value, 'https://otherdomain.com/path');
});

test('detects URL when allowlisted domain is a substring but not a parent domain', (t) => {
  const allowlistDetector = new UrlDetector(['example.com']);
  const findings = allowlistDetector.detect('Visit https://myexample.com/path');
  t.is(findings.length, 1);
  t.is(findings[0]?.value, 'https://myexample.com/path');
});

// --- Confidence ---

test('scores a scheme-qualified URL above a bare host/path', (t) => {
  const full = detector.detect('See https://api.example.com/v1/users');
  t.is(full[0]?.confidence, 0.95);
  t.is(full[0]?.method, 'exact-pattern');

  const bare = detector.detect('See api.example.com/v1/users');
  t.is(bare[0]?.confidence, 0.7);
  t.is(bare[0]?.method, 'heuristic');
});
