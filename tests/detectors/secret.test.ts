import test from 'ava';
import { rehydrateText } from '../../src/core/rehydrate.js';
import { scrub } from '../../src/core/scrub.js';
import { SecretDetector } from '../../src/detectors/secret.js';
import type { ScrubRequest } from '../../src/types/index.js';

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

test('detects a KEY=value pair that follows a non-secret `word:` lead-in', (t) => {
  for (const input of [
    'found: API_KEY=hunter2hunter2',
    'config:\nDB_PASSWORD=hunter2hunter2',
    'config:\r\nDB_PASSWORD=hunter2hunter2',
    'config:\n  nested:\n    secret: hunter2hunter2',
    'note: see config: TOKEN=hunter2hunter2',
    'env:\n  API_KEY: hunter2hunter2',
  ]) {
    const findings = detector.detect(input);
    t.is(findings.length, 1, input);
    t.is(findings[0]?.value, 'hunter2hunter2', input);
  }
});

test('detects a secret on the line after its own key', (t) => {
  for (const input of [
    'password:\n  correcthorsebatterystaple',
    'password:\r\n  correcthorsebatterystaple',
    'password =\n  correcthorsebatterystaple',
  ]) {
    const findings = detector.detect(input);
    t.is(findings.length, 1, input);
    t.is(findings[0]?.value, 'correcthorsebatterystaple', input);
  }
});

test('does not flag the line after a non-secret key', (t) => {
  t.is(detector.detect('notes:\nplain-words-only-here').length, 0);
});

test('does not mint a second placeholder for an already-scrubbed quoted value', (t) => {
  t.is(detector.detect('api_key="«Secret_1»"').length, 0);
  const once = scrub({ content: 'found: API_KEY="hunter2hunter2"', sessionMap: {} });
  const twice = scrub({ content: once.scrubbedContent, sessionMap: once.sessionMap });
  t.is(once.scrubbedContent, 'found: API_KEY="«Secret_1»"');
  t.is(twice.scrubbedContent, once.scrubbedContent);
});

test('still redacts a quoted secret that only looks like a placeholder', (t) => {
  for (const [input, value] of [
    ['password = "«hunter2hunter2»"', '«hunter2hunter2»'],
    ['api_key="«s3cr3tvalu3x9»"', '«s3cr3tvalu3x9»'],
    ['api_key="«Secret_x»"', '«Secret_x»'],
    ['api_key="«Secret_1» and more text"', '«Secret_1» and more text'],
  ] as const) {
    const findings = detector.detect(input);
    t.is(findings.length, 1, input);
    t.is(findings[0]?.value, value, input);
  }
});

test('detects a KEY=value pair that follows a character other than whitespace', (t) => {
  const pw = 'Zq8C3HczEdpYwvwux!x9';
  for (const input of [
    `\`DB_PASSWORD=${pw}\``,
    `(password: ${pw})`,
    `$password = "${pw}"`,
    `@password = "${pw}"`,
    `user=bob&password=${pw}`,
    `curl -d "user=bob&password=${pw}" https://example.com/login`,
    `?password=${pw}`,
    `<password=${pw}>`,
    `|password=${pw}|`,
    `env/API_KEY=${pw}`,
    `密码：password=${pw}`,
    `🔑password=${pw}`,
    `postgres://db.example.com/app?password=${pw}`,
  ]) {
    const findings = detector.detect(input);
    t.is(findings.length, 1, input);
    t.is(findings[0]?.value, pw, input);
  }
});

test('does not read a key out of the middle of a longer name', (t) => {
  t.is(detector.detect('max-connections=1234567890').length, 0);
  t.is(detector.detect('server.port=1234567890').length, 0);
});

const LONG_URL = `https://example.com/${'a/'.repeat(300)}`;

test('leaves a key inside an http(s) URL to the URL detector', (t) => {
  for (const input of [
    'https://api.example.com/v1?token=abcdefghijklmnop',
    'http://api.example.com/v1?a=1&password=abcdefghijklmnop',
    // However far into the URL the key sits.
    `${LONG_URL}?token=abcdefghijklmnop`,
    `${LONG_URL}?a=1&password=abcdefghijklmnop`,
  ]) {
    t.is(detector.detect(input).length, 0, input.slice(-40));
  }
});

test('always reports a pair that follows , or ; inside a URL', (t) => {
  // The scanner reported these before a key could follow any character, and the URL detector
  // may not cover them (see the next test), so they must not be left to it.
  for (const input of [
    'https://example.com/?a=1,token=abcdefghijklmnop',
    'https://example.com/v1;token=abcdefghijklmnop',
    `${LONG_URL};token=abcdefghijklmnop`,
  ]) {
    const findings = detector.detect(input);
    t.is(findings.length, 1, input.slice(-40));
    t.is(findings[0]?.value, 'abcdefghijklmnop', input.slice(-40));
  }
});

test('redacts a pair in a URL that the URL detector will not redact', (t) => {
  const cases: Array<[string, NonNullable<ScrubRequest['options']>, string]> = [
    // The URL detector rejects a URL with nothing after `https://` but a slash.
    ['https:///x;token=abcdefghijklmnop', {}, 'https:///x;token=«Secret_1»'],
    ['https:///x?token=abcdefghijklmnop', {}, 'https:///x?token=«Secret_1»'],
    // It leaves an allowlisted host's `;` and `,` parameters alone.
    [
      'https://example.com/v1;token=abcdefghijklmnop',
      { urlAllowlist: ['example.com'] },
      'https://example.com/v1;token=«Secret_1»',
    ],
    [
      'https://example.com/v1,token=abcdefghijklmnop',
      { urlAllowlist: ['example.com'] },
      'https://example.com/v1,token=«Secret_1»',
    ],
    // And it may be switched off.
    [
      'https://example.com/v1;token=abcdefghijklmnop',
      { disabledDetectors: ['UrlDetector'] },
      'https://example.com/v1;token=«Secret_1»',
    ],
    [
      'https://example.com/?a=1,token=abcdefghijklmnop',
      { disabledDetectors: ['UrlDetector'] },
      'https://example.com/?a=1,token=«Secret_1»',
    ],
  ];
  for (const [content, options, expected] of cases) {
    const result = scrub({ content, sessionMap: {}, options });
    t.is(result.scrubbedContent, expected, `${content} ${JSON.stringify(options)}`);
  }
});

test('a secret inside a URL leaves one placeholder for the whole URL, however long it is', (t) => {
  for (const content of [
    'https://example.com/v1?token=abcdefghijklmnop',
    `${LONG_URL}?token=abcdefghijklmnop`,
    `${LONG_URL}?a=1&password=abcdefghijklmnop`,
  ]) {
    t.is(scrub({ content, sessionMap: {} }).scrubbedContent, '«Url_1»', content.slice(-40));
  }
});

test('still finds a secret that comes after a URL rather than inside it', (t) => {
  for (const input of [
    'https://example.com/?a=1 token=abcdefghijklmnop',
    'https://example.com/?a=1\ttoken=abcdefghijklmnop',
    'https://example.com/?a=1\ntoken=abcdefghijklmnop',
    'see https://example.com/x, then token=abcdefghijklmnop',
    '(https://example.com/?a=1) token=abcdefghijklmnop',
    // The key runs on from the URL, but its value comes after the URL has ended.
    'https://example.com/v1,token: abcdefghijklmnop',
    'https://example.com/v1;password: abcdefghijklmnop',
    'https://example.com/v1,token="abcdefghijklmnop"',
    'https://example.com/v1?token="abcdefghijklmnop"',
    'https://example.com/v1?a=1&password: "abcdefghijklmnop"',
    // Characters the URL detector does not treat as part of a URL end it, so a key glued on is not in it.
    'https://example.com/a"token=abcdefghijklmnop"',
    'https://example.com/a|token=abcdefghijklmnop',
    'https://example.com/a?x=1#frag{token=abcdefghijklmnop}',
  ]) {
    const findings = detector.detect(input);
    t.is(findings.length, 1, input);
    t.is(findings[0]?.value, 'abcdefghijklmnop', input);
  }
});

test('a secret after `&` is redacted next to an email on one line', (t) => {
  const result = scrub({
    content: 'user=bob@example.com&password=Zq8C3HczEdpYwvwux!x9',
    sessionMap: {},
  });
  t.is(result.scrubbedContent, 'user=«Email_1»&password=«Secret_1»');
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

test('detects credentials embedded in connection strings as one unit', (t) => {
  for (const url of [
    'postgres://admin:s3cretPass@db.internal:5432/app',
    'mongodb+srv://u:p%40ss@cluster0.x.mongodb.net/test?retryWrites=true',
    'redis://:pw@host:6379',
    'redis://default:pw@host:6379/0',
    'amqp://guest:guest@rabbit:5672/',
    'ftp://bob:hunter22@ftp.example.com',
    'https://user:pass@example.com/x',
  ]) {
    const findings = detector.detect(`connect with ${url} now`);
    t.is(findings.length, 1, url);
    t.is(findings[0]?.value, url);
    t.is(findings[0]?.placeholderPrefix, 'Secret');
  }
});

test('connection string credentials stop before trailing punctuation', (t) => {
  t.is(
    detector.detect('(see https://user:pass@example.com/x).')[0]?.value,
    'https://user:pass@example.com/x',
  );
  t.is(
    detector.detect('use postgres://admin:pw@db.internal:5432/app.')[0]?.value,
    'postgres://admin:pw@db.internal:5432/app',
  );
});

test('ignores URLs without a password', (t) => {
  for (const text of [
    'ssh://git@github.com/o/r',
    'https://example.com/a:b@c',
    'https://example.com/docs',
    'mailto://nobody',
  ]) {
    t.is(detector.detect(text).length, 0, text);
  }
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
    `found: ${'a='.repeat(50_000)}`,
    'found: x=aaaaaaaa\n'.repeat(20_000),
    'a:'.repeat(50_000),
    'k:'.repeat(100_000),
    '::ffff:'.repeat(140_000),
    '`a:b`'.repeat(50_000),
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

test('detects an OpenAI project key in full, past 80 characters', (t) => {
  const key = `sk-proj-${'A1b2C3d4_-'.repeat(15)}T3BlbkFJ${'x9Y8z7W6'.repeat(2)}`;
  t.true(key.length > 160);
  const findings = detector.detect(`rotate ${key} today`);
  t.is(findings.length, 1);
  t.is(findings[0]?.value, key);
});

test('detects an Anthropic key in full', (t) => {
  const key = `sk-ant-api03-${'Zz9Yy8Xx-_'.repeat(9)}AA`;
  t.true(key.length > 100);
  const findings = detector.detect(`the key is "${key}" in the logs`);
  t.is(findings.length, 1);
  t.is(findings[0]?.value, key);
});

test('a long key ends at the first character that cannot be part of it', (t) => {
  const key = `sk-svcacct-${'Qq1Ww2Ee3Rr4'.repeat(10)}`;
  const findings = detector.detect(`use (${key}), then rotate`);
  t.is(findings.length, 1);
  t.is(findings[0]?.value, key);
});

test('a long key leaves no tail behind after scrubbing', (t) => {
  const key = `sk-proj-${'0123456789'.repeat(16)}`;
  const result = scrub({ content: `rotate ${key} today`, sessionMap: {} });
  t.is(result.scrubbedContent, 'rotate «Secret_1» today');
});

test('does not treat a short sk- string as a key', (t) => {
  for (const text of [
    'sk-',
    'sk-short',
    'sk-abc123 is not a key',
    'use sk-0123456789abcdefghi now',
  ]) {
    t.is(detector.detect(text).length, 0, text);
  }
});

test('a hyphenated word joined onto a key is redacted with it, never left behind', (t) => {
  const key = 'sk-0123456789abcdefghijklmnop';
  const findings = detector.detect(`token ${key}-rotate-now please`);
  t.is(findings.length, 1);
  t.is(findings[0]?.value, `${key}-rotate-now`);
  t.is(detector.detect(`token ${key} -rotate-now`)[0]?.value, key);
});

test('a long key next to another detector is redacted separately', (t) => {
  const key = `sk-proj-${'0123456789'.repeat(16)}`;
  const result = scrub({ content: `bob@example.com ${key}`, sessionMap: {} });
  t.is(result.scrubbedContent, '«Email_1» «Secret_1»');
  t.deepEqual(result.stats.byCategory, { Email: 1, Secret: 1 });
});

// --- Developer credentials: Stripe, JWT, PEM, GitLab, HuggingFace, npm, SendGrid, Slack webhook ---
// Fixtures are assembled at run time, so this file holds no string a secret scanner would
// take for a real credential.

const fill = (n: number) => 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ'.repeat(n).slice(0, n);
const rule = '-'.repeat(5);
const pem = (label: string) =>
  `${rule}BEGIN ${label}${rule}\n${fill(64)}\n${fill(60)}==\n${rule}END ${label}${rule}`;
const jwtHead = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9';
const jwtBody = 'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0';
const webhook = (...parts: string[]) =>
  ['https:/', 'hooks.slack.com', 'services', ...parts].join('/');

const tokens: [string, string][] = [
  ['Stripe secret key', ['sk', 'live', fill(99)].join('_')],
  ['Stripe restricted key', ['rk', 'live', fill(24)].join('_')],
  ['JWT', [jwtHead, jwtBody, fill(43)].join('.')],
  ['GitLab PAT', `glpat-${fill(20)}`],
  ['HuggingFace token', `hf_${fill(34)}`],
  ['npm token', `npm_${fill(36)}`],
  ['SendGrid key', `SG.${fill(22)}.${fill(43)}`],
  ['Slack webhook', webhook(`T0${fill(8)}`.toUpperCase(), `B0${fill(8)}`.toUpperCase(), fill(24))],
];

test('detects each developer credential whole, in prose and in brackets', (t) => {
  for (const [label, token] of tokens) {
    for (const text of [`use ${token} now`, `(${token}), next`, `"${token}"`]) {
      const findings = detector.detect(text);
      t.is(findings.length, 1, `${label}: ${text}`);
      t.is(findings[0]?.value, token, label);
      t.is(findings[0]?.confidence, 0.99, label);
      t.is(findings[0]?.method, 'exact-pattern', label);
    }
  }
});

test('a developer credential longer than its usual length is not cut short', (t) => {
  for (const [label, token] of tokens.filter(([label]) => label !== 'JWT')) {
    const longer = `${token}${fill(40)}`;
    t.is(detector.detect(`use ${longer} now`)[0]?.value, longer, label);
  }
});

test('detects a PEM private key block whole, whatever its type', (t) => {
  for (const label of [
    'PRIVATE KEY',
    'ENCRYPTED PRIVATE KEY',
    'RSA PRIVATE KEY',
    'EC PRIVATE KEY',
    'OPENSSH PRIVATE KEY',
  ]) {
    const key = pem(label);
    const findings = detector.detect(`cat key.pem\n${key}\ndone`);
    t.is(findings.length, 1, label);
    t.is(findings[0]?.value, key, label);
  }
});

test('scrubs a PEM key stored in JSON with escaped newlines, and restores it', (t) => {
  const key = pem('PRIVATE KEY').replaceAll('\n', '\\n');
  t.false(key.includes('\n'));
  const result = scrub({ content: `{"note": "${key}"}`, sessionMap: {} });
  t.is(result.scrubbedContent, '{"note": "«Secret_1»"}');
  t.is(rehydrateText(result.scrubbedContent, result.sessionMap).content, `{"note": "${key}"}`);
});

test('scrubs a multi-line PEM key and restores it exactly', (t) => {
  const key = pem('RSA PRIVATE KEY');
  const result = scrub({ content: `key:\n${key}\nok`, sessionMap: {} });
  t.is(result.scrubbedContent, 'key:\n«Secret_1»\nok');
  t.is(rehydrateText(result.scrubbedContent, result.sessionMap).content, `key:\n${key}\nok`);
});

test('does not match lookalikes of the developer credentials', (t) => {
  for (const text of [
    ['pk', 'live', fill(24)].join('_'), // Stripe publishable key, meant to be public
    ['sk', 'live', fill(23)].join('_'),
    `task_live_${fill(30)}`,
    `glpat-${fill(19)}`,
    `xglpat-${fill(20)}`,
    `hf_${fill(33)}`,
    `chf_${fill(40)}`,
    `npm_${fill(35)}`,
    'npm_config_registry is set',
    `SG.${fill(22)}.${fill(42)}`,
    `${jwtHead}.${jwtBody}`,
    `${jwtHead}.${fill(20)}.${fill(20)}`,
    webhook(),
    `see ${webhook()} for the docs`,
    pem('PUBLIC KEY'),
    pem('CERTIFICATE'),
  ]) {
    t.is(detector.detect(text).length, 0, text);
  }
});

test('a developer credential next to another detector is redacted separately', (t) => {
  const hook = webhook('T0AAAAAAAA', 'B0AAAAAAAA', fill(24));
  const jwt = [jwtHead, jwtBody, fill(43)].join('.');
  const credentials: [string, string][] = [...tokens, ['PEM private key', pem('PRIVATE KEY')]];
  for (const [label, token] of credentials) {
    const before = scrub({ content: `bob@example.com ${token}`, sessionMap: {} });
    t.is(before.scrubbedContent, '«Email_1» «Secret_1»', label);
    const after = scrub({ content: `${token} bob@example.com`, sessionMap: {} });
    t.is(after.scrubbedContent, '«Secret_1» «Email_1»', label);
  }
  t.is(
    scrub({ content: `curl -X POST ${hook} -d hi`, sessionMap: {} }).scrubbedContent,
    'curl -X POST «Secret_1» -d hi',
  );
  t.is(
    scrub({ content: `Authorization: Bearer ${jwt}`, sessionMap: {} }).scrubbedContent,
    'Authorization: Bearer «Secret_1»',
  );
});

test('scans repeated credential prefixes in linear time', (t) => {
  for (const input of [
    'eyJ'.repeat(30_000),
    `eyJ${'a'.repeat(12)}.`.repeat(20_000),
    `${rule}BEGIN PRIVATE KEY${rule}\n${fill(64)}\n`.repeat(5_000),
    'sk_live_'.repeat(20_000),
    'glpat-'.repeat(20_000),
    'https://hooks.slack.com/services/T0/B0/'.repeat(5_000),
  ]) {
    const start = Date.now();
    detector.detect(input);
    t.true(Date.now() - start < 1000, `took ${Date.now() - start}ms`);
  }
});
