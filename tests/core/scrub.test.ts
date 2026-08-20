import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'ava';
import { rehydrate } from '../../src/core/rehydrate.js';
import { scrub } from '../../src/core/scrub.js';
import type { Detector } from '../../src/types/index.js';

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

const germanAddressDetector: Detector = {
  name: 'AddressDeDetector',
  locales: ['de-DE'],
  detect(text) {
    const regex = /[A-ZÄÖÜ][a-zäöüß]+(?:straße|str\.)\s+\d{1,4}/g;
    const findings = [];
    let match: RegExpExecArray | null;
    regex.lastIndex = 0;
    while ((match = regex.exec(text)) !== null) {
      findings.push({
        category: 'Address',
        span: [match.index, match.index + match[0].length] as [number, number],
        value: match[0],
        placeholderPrefix: 'Address',
      });
    }
    return findings;
  },
};

test('a locale-scoped detector stays inactive when no locale is set', (t) => {
  const text = 'Ich wohne in der Musterstraße 12';
  const result = scrub({ content: text, options: { customDetectors: [germanAddressDetector] } });
  t.is(result.scrubbedContent, text);
});

test('a locale-scoped detector runs when its locale is active', (t) => {
  const result = scrub({
    content: 'Ich wohne in der Musterstraße 12',
    options: { customDetectors: [germanAddressDetector], locale: 'de-DE' },
  });
  t.is(result.scrubbedContent, 'Ich wohne in der «Address_1»');
});

test('a locale-scoped detector runs for a language-level locale', (t) => {
  const result = scrub({
    content: 'Ich wohne in der Musterstraße 12',
    options: { customDetectors: [germanAddressDetector], locale: 'de' },
  });
  t.is(result.scrubbedContent, 'Ich wohne in der «Address_1»');
});

test('a locale-scoped detector stays inactive for a different locale', (t) => {
  const text = 'Ich wohne in der Musterstraße 12';
  const result = scrub({
    content: text,
    options: { customDetectors: [germanAddressDetector], locale: 'fr-FR' },
  });
  t.is(result.scrubbedContent, text);
});

test('locale-agnostic custom detectors are unaffected by the active locale', (t) => {
  const codenameDetector: Detector = {
    name: 'CodenameDetector',
    detect: (text) =>
      text.includes('Apollo')
        ? [
            {
              category: 'Codename',
              span: [text.indexOf('Apollo'), text.indexOf('Apollo') + 6] as [number, number],
              value: 'Apollo',
              placeholderPrefix: 'Codename',
            },
          ]
        : [],
  };

  const result = scrub({
    content: 'Project Apollo',
    options: { customDetectors: [codenameDetector], locale: 'ja-JP' },
  });
  t.is(result.scrubbedContent, 'Project «Codename_1»');
});

test('an active locale does not change how English input is scrubbed', (t) => {
  const text = 'Write to alice@example.com or visit 123 Main Street.';
  const withLocale = scrub({
    content: text,
    options: { customDetectors: [germanAddressDetector], locale: 'de-DE' },
  });
  const withoutLocale = scrub({ content: text });
  t.is(withLocale.scrubbedContent, withoutLocale.scrubbedContent);
});

test('a locale finding wins over an overlapping built-in finding', (t) => {
  const streetOnlyDetector: Detector = {
    name: 'AddressDeShortDetector',
    locales: ['de-DE'],
    detect: (text) => {
      const idx = text.indexOf('Downing St');
      return idx === -1
        ? []
        : [
            {
              category: 'Address',
              span: [idx, idx + 'Downing St'.length] as [number, number],
              value: 'Downing St',
              placeholderPrefix: 'Address',
            },
          ];
    },
  };

  const text = 'Adresse: 10 Downing St, Berlin';
  t.is(scrub({ content: text }).scrubbedContent, 'Adresse: «Address_1», Berlin');
  t.is(
    scrub({ content: text, options: { customDetectors: [streetOnlyDetector], locale: 'de-DE' } })
      .scrubbedContent,
    'Adresse: 10 «Address_1», Berlin',
  );
});

test('a locale finding round-trips through rehydrate', (t) => {
  const text = 'Meine Adresse ist Musterstraße 12';
  const scrubbed = scrub({
    content: text,
    options: { customDetectors: [germanAddressDetector], locale: 'de-DE' },
  });
  const restored = rehydrate({
    content: scrubbed.scrubbedContent as string,
    sessionId: scrubbed.sessionId,
  });
  t.is(restored.content, text);
});
