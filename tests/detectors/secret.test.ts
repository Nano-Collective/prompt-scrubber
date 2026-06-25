import test from 'ava';
import { SecretDetector } from '../../src/detectors/secret.js';

const detector = new SecretDetector();

// --- Positive Cases: Prefix Patterns ---

test('detects OpenAI API key (sk- prefix)', (t) => {
  const findings = detector.detect('Key: sk-aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890abcdefghijklmno');
  t.is(findings.length, 1);
  t.is(findings[0]?.placeholderPrefix, 'Secret');
  t.true(findings[0]!.value.startsWith('sk-'));
});

test('detects GitHub personal access token (ghp_ prefix)', (t) => {
  const findings = detector.detect('Token: ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890');
  t.is(findings.length, 1);
  t.true(findings[0]!.value.startsWith('ghp_'));
});

test('detects AWS Access Key ID (AKIA prefix)', (t) => {
  const findings = detector.detect('AWS key: AKIAIOSFODNN7EXAMPLE in config');
  t.is(findings.length, 1);
  t.true(findings[0]!.value.startsWith('AKIA'));
});

test('detects Google API key (AIza prefix)', (t) => {
  const findings = detector.detect('google_api_key = AIzaSyD-9tSrke72I6kT0lKjT5hTjHfkHj3sxDM');
  t.true(findings.length >= 1);
  const apiKey = findings.find((f) => f.value.startsWith('AIza'));
  t.truthy(apiKey);
});

test('detects Bearer token in Authorization header', (t) => {
  const findings = detector.detect(
    'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc',
  );
  t.is(findings.length, 1);
});

// --- Positive Cases: Key-Value Heuristic ---

test('detects secret via key-value pattern (KEY=value)', (t) => {
  const findings = detector.detect('API_KEY=super-secret-value-here');
  t.true(findings.length >= 1);
  const found = findings.find((f) => f.value === 'super-secret-value-here');
  t.truthy(found);
});

test('detects secret via key-value pattern (TOKEN: value)', (t) => {
  const findings = detector.detect('token: my-very-secret-token-value');
  t.true(findings.length >= 1);
});

test('detects password via key-value pattern', (t) => {
  const findings = detector.detect('PASSWORD=correcthorsebatterystaple');
  t.true(findings.length >= 1);
});

// --- Positive Cases: High Entropy ---

test('detects high-entropy base64 string in quotes', (t) => {
  // High-entropy string that looks like a secret
  const entropy = 'aB3dEf7gHi9JkLm2NoPqR5sTuV8wXyZ';
  const findings = detector.detect(`token = "${entropy}"`);
  t.true(findings.length >= 1);
});

// --- Negative Cases ---

test('does not match ordinary words', (t) => {
  const findings = detector.detect('This is a normal sentence with no secrets.');
  t.is(findings.length, 0);
});

test('does not match a short value in a key=value pair', (t) => {
  const findings = detector.detect('PORT=8080');
  t.is(findings.length, 0);
});

test('does not match low-entropy value in quotes', (t) => {
  // 'aaaa...' has entropy ~0 — should not fire even when followed by quotes
  const findings = detector.detect('color = "aaaaaaaaaaaaaaaaaaaaaaaaa"');
  t.is(findings.length, 0);
});

test('returns empty for clean prompt text', (t) => {
  const findings = detector.detect('Please summarize this document for me.');
  t.is(findings.length, 0);
});
