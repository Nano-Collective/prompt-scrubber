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

test('detects high-entropy string without key-value context', (t) => {
  const entropy = 'aB3dEf7gHi9JkLm2NoPqR5sTuV8wXyZ';
  const findings = detector.detect(`"${entropy}"`);
  t.is(findings.length, 1);
  t.is(findings[0]?.value, entropy);
});

test('replaces shorter overlap with longer overlap', (t) => {
  const longSecret = 'AIzaSyD9tSrke72I6kT0lKjT5hTjHfkHj3sxDMaB3dEf7gHi9JkLm2NoPqR5sTuV8wXyZ';
  const findings = detector.detect(`"${longSecret}"`);
  t.is(findings.length, 1);
  t.is(findings[0]?.value, longSecret);
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

// --- Confidence ---

test('scores a vendor-prefixed key as all but certain', (t) => {
  const findings = detector.detect('AWS key: AKIAIOSFODNN7EXAMPLE in config');
  t.is(findings[0]?.confidence, 0.99);
  t.is(findings[0]?.method, 'exact-pattern');
});

test('scores a Bearer token slightly below a vendor prefix', (t) => {
  const findings = detector.detect(
    'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc',
  );
  t.is(findings[0]?.confidence, 0.9);
  t.is(findings[0]?.method, 'exact-pattern');
});

test('scores a key-name match below an exact pattern', (t) => {
  const findings = detector.detect('API_KEY=super-secret-value-here');
  const found = findings.find((f) => f.value === 'super-secret-value-here');
  t.is(found?.confidence, 0.7);
  t.is(found?.method, 'key-name');
});

test('scores a bare high-entropy string lowest', (t) => {
  const findings = detector.detect('value = "aB3dEf7gHi9JkLm2NoPqR5sTuV8wXyZ"');
  t.is(findings[0]?.confidence, 0.6);
  t.is(findings[0]?.method, 'entropy');
});

test('a wider low-confidence overlap does not downgrade a vendor-prefixed key', (t) => {
  // The key-name layer matches one character more than the AWS pattern (the
  // trailing '.'), so it wins the span; the score must still reflect the key.
  const findings = detector.detect('aws_access_key_id=AKIAIOSFODNN7EXAMPLE.');
  t.is(findings.length, 1);
  t.is(findings[0]?.value, 'AKIAIOSFODNN7EXAMPLE.');
  t.is(findings[0]?.confidence, 0.99);
  t.is(findings[0]?.method, 'exact-pattern');
});

test('detects a secret under a quoted key', (t) => {
  for (const [text, value] of [
    ['{"api_key": "mysecretvalue123"}', 'mysecretvalue123'],
    ["{'password': 'hunter2hunter2'}", 'hunter2hunter2'],
    ['"client_secret":"abcd1234efgh5678"', 'abcd1234efgh5678'],
  ] as const) {
    const findings = detector.detect(text);
    t.is(findings.length, 1, text);
    t.is(findings[0]?.value, value, text);
  }
});

test('takes a password with punctuation whole', (t) => {
  for (const [text, value] of [
    ['password: Secret!Pass123', 'Secret!Pass123'],
    ['DB_PASSWORD=P@ss!w0rd#2024', 'P@ss!w0rd#2024'],
    ['password: "my long pass phrase 99"', 'my long pass phrase 99'],
    ['token=abc$def%ghi^jkl', 'abc$def%ghi^jkl'],
  ] as const) {
    const findings = detector.detect(text);
    t.is(findings.length, 1, text);
    t.is(findings[0]?.value, value, text);
  }
});

test('an unquoted value stops at brackets, quotes and commas', (t) => {
  t.is(detector.detect('call password=abcd1234efgh) now')[0]?.value, 'abcd1234efgh');
  t.is(detector.detect('use [ token=abcd1234efgh], next')[0]?.value, 'abcd1234efgh');
  t.is(detector.detect("run token=abcd1234efgh'")[0]?.value, 'abcd1234efgh');
});

test('a weak key word must be a whole word of the name, not a piece of another word', (t) => {
  for (const text of [
    'author: jonathan-smith-the-third',
    'monkey=bananabananabanana',
    'compass=northnorthnorthnorth',
    'keyword=somethingverylong',
    'turkey=roastroastroast',
    'hockey=stickstickstick',
    'bypass=roadroadroadroad',
    'trespass=signsignsignsign',
    'keynote=slidesslidesslides',
    'apiary=beesbeesbeesbees',
    'authority=governmentgov',
  ]) {
    t.is(detector.detect(text).length, 0, text);
  }
});

test('finds compound key names that glue a secret word onto another word', (t) => {
  for (const text of [
    'refreshtoken=abcdefgh1234',
    'accesstoken=abcdefgh1234',
    'privatekey=abcdefgh1234',
    'masterkey=abcdefgh1234',
    'signingkey=abcdefgh1234',
    'secretkey=abcdefgh1234',
    'clientsecret=abcdefgh1234',
    'awssecretaccesskey=abcdefgh1234',
    'AWS_SECRET_ACCESS_KEY=abcdefgh1234',
    'DB_PASSWORD=abcdefgh1234',
    'password1=abcdefgh1234',
    'key2=abcdefgh1234',
    'token_2=abcdefgh1234',
    'apikey=abcdefgh1234',
    'passkey=abcdefgh1234',
    'oauth=abcdefgh1234',
    'sessionkey=abcdefgh1234',
    'x-api-key: abcdefgh1234',
    'creds=abcdefgh1234',
  ]) {
    t.is(detector.detect(text).length, 1, text);
  }
});

test('an unquoted value stops where the next query parameter starts', (t) => {
  for (const text of [
    'token=abcdefghij&redirect=/home',
    'token=abcdefghij?page=2',
    'token=abcdefghij&next=1',
  ]) {
    t.is(detector.detect(text)[0]?.value, 'abcdefghij', text);
  }
});

test('keeps base64 padding on an unquoted value', (t) => {
  t.is(
    detector.detect('token=QWxhZGRpbjpvcGVuIHNlc2FtZQ==')[0]?.value,
    'QWxhZGRpbjpvcGVuIHNlc2FtZQ==',
  );
});

test('recognises secret words in snake, kebab, camel and upper case', (t) => {
  for (const text of [
    'secret_key=abcdefgh12345678',
    'client-secret=abcdefgh12345678',
    'accessToken: abcdefgh12345678',
    'API_KEY=abcdefgh12345678',
    'apikey=abcdefgh12345678',
    'x.auth.token=abcdefgh12345678',
  ]) {
    t.is(detector.detect(text).length, 1, text);
  }
});

test('does not start an sk- key in the middle of a word', (t) => {
  t.is(detector.detect('risk-assessment_2024').length, 0);
  t.is(detector.detect('see task-force-leader-abcdefghijklmnop').length, 0);
  t.is(detector.detect('use sk-aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890 now').length, 1);
  t.is(detector.detect('"sk-aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890"').length, 1);
});

test('detects an upper-case Bearer scheme', (t) => {
  for (const scheme of ['Bearer', 'bearer', 'BEARER']) {
    const findings = detector.detect(`Authorization: ${scheme} aaaaaaaaaaaaaaaaaaaaa`);
    t.is(findings.length, 1, scheme);
    t.is(findings[0]?.value, 'aaaaaaaaaaaaaaaaaaaaa');
  }
});

test('scans pathological key-value input in linear time', (t) => {
  for (const input of [
    ` ${'a='.repeat(50_000)}`,
    `password: ${'!'.repeat(100_000)}`,
    `password="${'a'.repeat(100_000)}`,
    'sk-'.repeat(30_000),
    'Bearer '.repeat(20_000),
  ]) {
    const start = Date.now();
    detector.detect(input);
    t.true(Date.now() - start < 1000, `took ${Date.now() - start}ms`);
  }
});
