import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'ava';
import { rehydrate } from '../../src/core/rehydrate.js';
import { DEFAULT_CONFIDENCE, scrub } from '../../src/core/scrub.js';

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

// --- Confidence Filtering ---

// 'ask' stays lowercase: NameDetector would otherwise read 'Ask Alice' as one name.
const NAME_AND_EMAIL = 'ask Alice about alice@example.com';

test('every finding is scored by default, and nothing is filtered', (t) => {
  const result = scrub({
    content: NAME_AND_EMAIL,
    options: { enabledDetectors: ['NameDetector'] },
  });
  t.is(result.scrubbedContent, 'ask «Name_1» about «Email_1»');
});

test('minConfidence drops findings scored below the threshold', (t) => {
  // NameDetector scores 0.5, EmailDetector 0.95.
  const result = scrub({
    content: NAME_AND_EMAIL,
    options: { enabledDetectors: ['NameDetector'], minConfidence: 0.8 },
  });
  t.is(result.scrubbedContent, 'ask Alice about «Email_1»');
  t.is(result.stats.totalEntities, 1);
  t.deepEqual(result.stats.byCategory, { Email: 1 });
});

test('a threshold above every score leaves the content untouched', (t) => {
  const result = scrub({ content: NAME_AND_EMAIL, options: { minConfidence: 1 } });
  t.is(result.scrubbedContent, NAME_AND_EMAIL);
  t.is(result.stats.totalEntities, 0);
  t.deepEqual(result.sessionMap, {});
});

test('minConfidence applies to every message in a Message[] payload', (t) => {
  const result = scrub({
    content: [
      { role: 'user', content: 'ask Alice' },
      { role: 'user', content: 'mail alice@example.com' },
    ],
    options: { enabledDetectors: ['NameDetector'], minConfidence: 0.8 },
  });
  t.deepEqual(result.scrubbedContent, [
    { role: 'user', content: 'ask Alice' },
    { role: 'user', content: 'mail «Email_1»' },
  ]);
});

test('a detector that reports no confidence is scored as DEFAULT_CONFIDENCE', (t) => {
  const unscored = {
    name: 'UnscoredDetector',
    detect: (text: string) => {
      const index = text.indexOf('CustomToken');
      return index === -1
        ? []
        : [
            {
              category: 'Custom',
              span: [index, index + 'CustomToken'.length] as [number, number],
              value: 'CustomToken',
              placeholderPrefix: 'Custom',
            },
          ];
    },
  };

  const kept = scrub({
    content: 'Check CustomToken.',
    options: { customDetectors: [unscored], minConfidence: DEFAULT_CONFIDENCE },
  });
  t.is(kept.scrubbedContent, 'Check «Custom_1».');

  const dropped = scrub({
    content: 'Check CustomToken.',
    options: { customDetectors: [unscored], minConfidence: DEFAULT_CONFIDENCE + 0.1 },
  });
  t.is(dropped.scrubbedContent, 'Check CustomToken.');
});

test('a filtered-out finding cannot suppress the overlapping finding it outranks', (t) => {
  // Secret beats Email in collision resolution, so unfiltered this fabricated
  // low-confidence Secret swallows the address. Filtering runs first, so once
  // it is below the threshold the Email is detected instead of being masked.
  const weakSecret = {
    name: 'WeakSecretDetector',
    detect: (text: string) => {
      const index = text.indexOf('alice@example.com');
      return index === -1
        ? []
        : [
            {
              category: 'Secret',
              span: [index, index + 'alice@example.com'.length] as [number, number],
              value: 'alice@example.com',
              placeholderPrefix: 'Secret',
              confidence: 0.3,
              method: 'entropy',
            },
          ];
    },
  };

  const unfiltered = scrub({
    content: 'mail alice@example.com',
    options: { customDetectors: [weakSecret] },
  });
  t.is(unfiltered.scrubbedContent, 'mail «Secret_1»');

  const filtered = scrub({
    content: 'mail alice@example.com',
    options: { customDetectors: [weakSecret], minConfidence: 0.8 },
  });
  t.is(filtered.scrubbedContent, 'mail «Email_1»');
});
