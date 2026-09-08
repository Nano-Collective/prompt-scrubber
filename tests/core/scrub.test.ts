import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'ava';
import { rehydrate } from '../../src/core/rehydrate.js';
import { scrub } from '../../src/core/scrub.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const tmpConfigDir = path.join(__dirname, '.tmp-config-scrub');

test.before(() => {
  // PROMPT_SCRUB_CONFIG_DIR is honored on every platform; XDG_CONFIG_HOME is only
  // read on Linux, so it does not isolate storage on macOS/Windows (which caused
  // tests to read/write the user's real session dir).
  process.env.PROMPT_SCRUB_CONFIG_DIR = tmpConfigDir;
  if (fs.existsSync(tmpConfigDir)) {
    fs.rmSync(tmpConfigDir, { recursive: true, force: true });
  }
});

test.after.always(() => {
  if (fs.existsSync(tmpConfigDir)) {
    fs.rmSync(tmpConfigDir, { recursive: true, force: true });
  }
});

// --- String Input ---

test('scrubs a single email from a plain string', (t) => {
  const result = scrub({ content: 'My email is hello@example.com' });
  t.is(result.scrubbedContent, 'My email is «Email_1»');
  t.truthy(result.sessionId);
});

test('scrubs multiple finding types in one pass', (t) => {
  const result = scrub({
    content: 'Email: alice@foo.com  URL: https://api.example.com',
  });
  const scrubbed = result.scrubbedContent as string;
  t.false(scrubbed.includes('alice@foo.com'));
  t.false(scrubbed.includes('https://api.example.com'));
  t.regex(scrubbed, /Email_\d/);
  t.regex(scrubbed, /Url_\d/);
});

test('scrubbing the same value twice generates the same placeholder', (t) => {
  const result1 = scrub({ content: 'Contact: repeat@example.com' });
  const result2 = scrub({
    content: 'Again: repeat@example.com',
    sessionId: result1.sessionId,
  });
  t.is(result1.scrubbedContent, 'Contact: «Email_1»');
  t.is(result2.scrubbedContent, 'Again: «Email_1»');
});

test('returns a valid sessionId', (t) => {
  const result = scrub({ content: 'Call +44 7911 123456' });
  t.truthy(result.sessionId);
  t.is(typeof result.sessionId, 'string');
});

test('disabledDetectors suppresses named detector', (t) => {
  const result = scrub({
    content: 'Email me at test@example.com',
    options: { disabledDetectors: ['EmailDetector'] },
  });
  // Email should NOT be scrubbed
  t.is(result.scrubbedContent, 'Email me at test@example.com');
});

test('disabledDetectors suppresses named detector even without Detector suffix', (t) => {
  const result = scrub({
    content: 'Email me at test@example.com',
    options: { disabledDetectors: ['Email'] },
  });
  t.is(result.scrubbedContent, 'Email me at test@example.com');
});

test('scrub works gracefully when options is empty object', (t) => {
  const result = scrub({
    content: 'My email is test@example.com',
    options: {},
  });
  t.is(result.scrubbedContent, 'My email is «Email_1»');
});

test('customDetectors option adds a detector on top of defaults', (t) => {
  const customDetector = {
    name: 'CustomDetector',
    detect: (text: string) => {
      const match = text.match(/CustomToken/);
      if (match) {
        return [
          {
            category: 'Custom',
            span: [match.index!, match.index! + match[0].length] as [number, number],
            value: match[0],
            placeholderPrefix: 'Custom',
          },
        ];
      }
      return [];
    },
  };

  const result = scrub({
    content: 'Check test@example.com and CustomToken.',
    options: { customDetectors: [customDetector] },
  });
  t.is(result.scrubbedContent, 'Check «Email_1» and «Custom_1».');
});

test('no disk write when nothing is scrubbed', (t) => {
  const sessionsBefore = fs.existsSync(path.join(tmpConfigDir, 'prompt-scrub', 'sessions'))
    ? fs.readdirSync(path.join(tmpConfigDir, 'prompt-scrub', 'sessions')).length
    : 0;

  scrub({ content: 'This string has no sensitive content at all.' });

  const sessionsAfter = fs.existsSync(path.join(tmpConfigDir, 'prompt-scrub', 'sessions'))
    ? fs.readdirSync(path.join(tmpConfigDir, 'prompt-scrub', 'sessions')).length
    : 0;

  t.is(sessionsBefore, sessionsAfter);
});

// --- Message[] Input ---

test('Message[] input: scrubs each message independently and preserves structure', (t) => {
  const result = scrub({
    content: [
      { role: 'user', content: 'My email is user@example.com' },
      { role: 'assistant', content: 'Hello! How can I help?' },
    ],
  });

  t.false(typeof result.scrubbedContent === 'string');
  const messages = result.scrubbedContent as Array<{ role: string; content: string }>;

  t.is(messages.length, 2);
  t.is(messages[0]?.role, 'user');
  t.is(messages[0]?.content, 'My email is «Email_1»');
  t.is(messages[1]?.role, 'assistant');
  // Assistant message has no PII — should be unchanged
  t.is(messages[1]?.content, 'Hello! How can I help?');
});

test('Message[] input: each message gets its own scrubbing within shared session', (t) => {
  const result = scrub({
    content: [
      { role: 'user', content: 'From alice@example.com' },
      { role: 'user', content: 'Also from alice@example.com' },
    ],
  });

  const messages = result.scrubbedContent as Array<{ role: string; content: string }>;
  // Same email in both messages should map to same placeholder
  t.is(messages[0]?.content, 'From «Email_1»');
  t.is(messages[1]?.content, 'Also from «Email_1»');
});

test('postal address round-tripping works correctly', (t) => {
  const text = 'Send it to 123 Main Street or 1600 Pennsylvania Ave.';
  const scrubbed = scrub({ content: text });

  t.is(scrubbed.scrubbedContent, 'Send it to «Address_2» or «Address_1»');

  const restored = rehydrate({
    content: scrubbed.scrubbedContent as string,
    sessionId: scrubbed.sessionId,
  });

  t.is(restored.content, text);
});

test('NameDetector is off by default', (t) => {
  const text = 'John Doe lives in London.';
  const scrubbed = scrub({ content: text });

  // NameDetector should not run, so the text should remain unmodified
  t.is(scrubbed.scrubbedContent, text);
});

test('NameDetector works when explicitly enabled', (t) => {
  const text = 'John Doe lives in London.';
  const scrubbed = scrub({
    content: text,
    options: { enabledDetectors: ['NameDetector'] },
  });
  t.is(scrubbed.scrubbedContent, '«Name_2» lives in «Name_1».');
});

test('NameDetector works in strict mode', (t) => {
  // Names and unknown proper nouns are detected, while allowlisted countries are not.
  const text = 'John visited France and London.';
  const scrubbed = scrub({
    content: text,
    options: {
      enabledDetectors: ['NameDetector'],
      strictNameDetector: true,
    },
  });

  t.is(scrubbed.scrubbedContent, '«Name_2» visited France and «Name_1».');
});

test('NameDetector round-trips correctly', (t) => {
  const text = 'Alice went to Paris.';
  const scrubbed = scrub({
    content: text,
    options: { enabledDetectors: ['NameDetector'] },
  });
  t.is(scrubbed.scrubbedContent, '«Name_2» went to «Name_1».');

  const restored = rehydrate({
    content: scrubbed.scrubbedContent as string,
    sessionId: scrubbed.sessionId,
  });

  t.is(restored.content, text);
});

test('CodeTellDetector is a no-op by default', (t) => {
  const text = 'const instance = new SecretClass();';
  const scrubbed = scrub({ content: text });
  t.is(scrubbed.scrubbedContent, text);
});

test('CodeTellDetector runs when terms are provided and round-trips correctly', (t) => {
  const text = 'const instance = new SecretClass();';
  const scrubbed = scrub({
    content: text,
    options: { codeTellTerms: ['SecretClass'] },
  });
  t.is(scrubbed.scrubbedContent, 'const instance = new «CodeTell_1»();');

  const restored = rehydrate({
    content: scrubbed.scrubbedContent as string,
    sessionId: scrubbed.sessionId,
  });
  t.is(restored.content, text);
});

// --- Statistics ---

test('stats report totals and per-category counts in order of appearance', (t) => {
  const result = scrub({
    content:
      'Mail alice@foo.com about sk-abcdefghijklmnopqrstuvwxyz and sk-0123456789abcdefghijklm',
  });

  t.is(result.stats.totalEntities, 3);
  t.deepEqual(result.stats.byCategory, { Email: 1, Secret: 2 });
  t.deepEqual(Object.keys(result.stats.byCategory), ['Email', 'Secret']);
});

test('stats count every replacement, including repeats of the same value', (t) => {
  const result = scrub({ content: 'dup@example.com and dup@example.com' });

  t.is(result.scrubbedContent, '«Email_1» and «Email_1»');
  t.is(result.stats.totalEntities, 2);
  t.deepEqual(result.stats.byCategory, { Email: 2 });
});

test('stats are zeroed when nothing is detected', (t) => {
  const result = scrub({ content: 'nothing sensitive here' });

  t.is(result.stats.totalEntities, 0);
  t.deepEqual(result.stats.byCategory, {});
});

test('stats aggregate across every message of a Message[] input', (t) => {
  const result = scrub({
    content: [
      { role: 'user', content: 'Mail alice@foo.com' },
      { role: 'assistant', content: 'See https://api.example.com and bob@foo.com' },
    ],
  });

  t.is(result.stats.totalEntities, 3);
  t.deepEqual(result.stats.byCategory, { Email: 2, Url: 1 });
});

test('stats cover only the current call when a session is reused', (t) => {
  const first = scrub({ content: 'Mail alice@foo.com', sessionId: 'stats-session' });
  const second = scrub({
    content: 'Mail alice@foo.com and bob@foo.com',
    sessionId: 'stats-session',
  });

  t.is(first.stats.totalEntities, 1);
  t.is(second.stats.totalEntities, 2);
  t.deepEqual(second.stats.byCategory, { Email: 2 });
});

test('stats include categories contributed by custom detectors', (t) => {
  const result = scrub({
    content: 'ticket JIRA-42 for alice@foo.com',
    options: {
      customDetectors: [
        {
          name: 'TicketDetector',
          detect: (text: string) => {
            const match = text.match(/JIRA-\d+/);
            if (!match || match.index === undefined) return [];
            return [
              {
                category: 'Ticket',
                span: [match.index, match.index + match[0].length] as [number, number],
                value: match[0],
                placeholderPrefix: 'Ticket',
              },
            ];
          },
        },
      ],
    },
  });

  t.is(result.stats.totalEntities, 2);
  t.deepEqual(result.stats.byCategory, { Ticket: 1, Email: 1 });
});

test('ip address scrubbing and round-tripping works correctly', (t) => {
  const original = 'Server at 192.168.1.1 and ipv6 2001:db8::1';
  const scrubResult = scrub({ content: original });
  t.is(scrubResult.scrubbedContent, 'Server at «IpAddress_2» and ipv6 «IpAddress_1»');

  const rehydrated = rehydrate({
    content: scrubResult.scrubbedContent,
    sessionMap: scrubResult.sessionMap,
  });
  t.is(rehydrated.content, original);
});

test('credit card scrubbing and round-tripping works correctly', (t) => {
  const original = 'Visa: 4532-0150-0000-0007, Amex: 3782 822463 10005';
  const scrubResult = scrub({ content: original });
  t.is(scrubResult.scrubbedContent, 'Visa: «CreditCard_2», Amex: «CreditCard_1»');

  const rehydrated = rehydrate({
    content: scrubResult.scrubbedContent,
    sessionMap: scrubResult.sessionMap,
  });
  t.is(rehydrated.content, original);
});

test('ssn scrubbing and round-tripping works correctly', (t) => {
  const original = 'User SSN is 123-45-6789.';
  const scrubResult = scrub({ content: original });
  t.is(scrubResult.scrubbedContent, 'User SSN is «Ssn_1».');

  const rehydrated = rehydrate({
    content: scrubResult.scrubbedContent,
    sessionMap: scrubResult.sessionMap,
  });
  t.is(rehydrated.content, original);
});

test('iban scrubbing and round-tripping works correctly', (t) => {
  const original = 'Wire to GB82 WEST 1234 5698 7654 32 today';
  const scrubResult = scrub({ content: original });
  t.is(scrubResult.scrubbedContent, 'Wire to «Iban_1» today');

  const rehydrated = rehydrate({
    content: scrubResult.scrubbedContent,
    sessionMap: scrubResult.sessionMap,
  });
  t.is(rehydrated.content, original);
});

test('disabledDetectors suppresses the high-risk PII detectors', (t) => {
  const original = 'Card 4532-0150-0000-0007, SSN 123-45-6789, IBAN GB82 WEST 1234 5698 7654 32';
  const result = scrub({
    content: original,
    options: {
      disabledDetectors: ['CreditCardDetector', 'SsnDetector', 'IbanDetector'],
    },
  });

  t.is(result.scrubbedContent, original);
  t.is(result.stats.totalEntities, 0);
});

test('disabledDetectors normalises IpAddressDetector without the Detector suffix', (t) => {
  const result = scrub({
    content: 'Server at 192.168.1.1',
    options: { disabledDetectors: ['IpAddress'] },
  });

  t.is(result.scrubbedContent, 'Server at 192.168.1.1');
});

test('an IP inside a URL resolves to the higher-priority Url finding', (t) => {
  const result = scrub({ content: 'Admin at http://192.168.1.1:8080/admin now' });

  t.is(result.scrubbedContent, 'Admin at «Url_1» now');
  t.deepEqual(result.stats.byCategory, { Url: 1 });
});

// Realistic non-PII strings that the high-risk detectors must leave untouched.
// The four detectors added for #89 all sit above Email/Url/Path/Phone in the
// priority table, so a false positive here silently mangles ordinary content.
const NEGATIVE_CORPUS = [
  'Order number 123456789 shipped.',
  'Error code 402551234 returned.',
  'Invoice 987654321 is overdue',
  'Upgrade from 1.2.3 to 2.0.0',
  'Release 10.15.7 build 4532015000000007x',
  'Timestamp 1735689600000 recorded',
  'Device MAC: 00:1A:2B:3C:4D:5E on eth0',
  'Commit 9f2b4c1a8e3d5f7b0c2a4e6d8b1f3a5c7e9d0b2f landed',
  'Namespace std::vector and a :: b in prose',
  'Tracking 1Z999AA10123456784 delivered',
  'Zip 90210-1234 and phone extension 4567',
];

for (const sample of NEGATIVE_CORPUS) {
  test(`negative corpus: leaves "${sample}" untouched`, (t) => {
    const result = scrub({ content: sample });
    t.is(result.scrubbedContent, sample);
    t.is(result.stats.totalEntities, 0);
  });
}
