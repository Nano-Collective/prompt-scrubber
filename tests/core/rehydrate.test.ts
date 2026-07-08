import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'ava';
import { rehydrate } from '../../src/core/rehydrate.js';
import { writeSessionMap } from '../../src/session/storage.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const tmpConfigDir = path.join(__dirname, '.tmp-config-rehydrate');

test.before(() => {
  process.env.XDG_CONFIG_HOME = tmpConfigDir;
  if (fs.existsSync(tmpConfigDir)) {
    fs.rmSync(tmpConfigDir, { recursive: true, force: true });
  }
});

test.after.always(() => {
  if (fs.existsSync(tmpConfigDir)) {
    fs.rmSync(tmpConfigDir, { recursive: true, force: true });
  }
});

// Helper: write a known session map and return the sessionId
function seedSession(sessionId: string, map: Record<string, string>): string {
  writeSessionMap(sessionId, map);
  return sessionId;
}

test('rehydrates a single placeholder', (t) => {
  const sessionId = seedSession('rh-single', { '«Email_1»': 'alice@example.com' });
  const result = rehydrate({ content: 'Contact: «Email_1»', sessionId });
  t.is(result.content, 'Contact: alice@example.com');
  t.falsy(result.warnings);
});

test('rehydrates multiple different placeholders', (t) => {
  const sessionId = seedSession('rh-multi', {
    '«Email_1»': 'alice@example.com',
    '«Url_1»': 'https://api.example.com',
    '«Secret_1»': 'sk-secret123',
  });
  const result = rehydrate({
    content: 'Email: «Email_1»  URL: «Url_1»  Key: «Secret_1»',
    sessionId,
  });
  t.is(result.content, 'Email: alice@example.com  URL: https://api.example.com  Key: sk-secret123');
  t.falsy(result.warnings);
});

test('longest placeholder is replaced first — «Email_10» not corrupted by «Email_1»', (t) => {
  const sessionId = seedSession('rh-longest', {
    '«Email_1»': 'first@example.com',
    '«Email_10»': 'tenth@example.com',
  });
  const result = rehydrate({
    content: 'Users: «Email_1» and «Email_10»',
    sessionId,
  });
  t.is(result.content, 'Users: first@example.com and tenth@example.com');
  t.falsy(result.warnings);
});

test('hallucinated placeholder is left as-is with a warning', (t) => {
  const sessionId = seedSession('rh-hallucinated', { '«Email_1»': 'alice@example.com' });
  const result = rehydrate({
    content: 'Contact: «Email_1» and see «Email_99»',
    sessionId,
  });
  t.is(result.content, 'Contact: alice@example.com and see «Email_99»');
  t.truthy(result.warnings);
  t.is(result.warnings?.length, 1);
  t.regex(result.warnings![0]!, /«Email_99»/);
  t.regex(result.warnings![0]!, /not found in session/);
});

test('multiple warnings for multiple hallucinated placeholders', (t) => {
  const sessionId = seedSession('rh-multi-hallucinated', {});
  const result = rehydrate({
    content: 'Values: «Email_1» and «Phone_1»',
    sessionId,
  });
  t.is(result.content, 'Values: «Email_1» and «Phone_1»');
  t.is(result.warnings?.length, 2);
});

test('string with no placeholders returns unchanged with no warnings', (t) => {
  const sessionId = seedSession('rh-noop', { '«Email_1»': 'a@b.com' });
  const result = rehydrate({
    content: 'This string has no placeholders at all.',
    sessionId,
  });
  t.is(result.content, 'This string has no placeholders at all.');
  t.falsy(result.warnings);
});

test('same placeholder appearing multiple times is fully replaced', (t) => {
  const sessionId = seedSession('rh-repeat', { '«Email_1»': 'bob@example.com' });
  const result = rehydrate({
    content: '«Email_1» said hello to «Email_1»',
    sessionId,
  });
  t.is(result.content, 'bob@example.com said hello to bob@example.com');
});

test('Message[] input is rehydrated and structure is preserved', (t) => {
  const sessionId = seedSession('rh-msg-arr', {
    '«Email_1»': 'alice@example.com',
    '«Secret_1»': 'sk-secret123',
  });
  const messages = [
    { role: 'system', content: 'You are an assistant. Do not leak «Secret_1».' },
    { role: 'user', content: 'My email is «Email_1»' },
    { role: 'assistant', content: 'I will not leak «Secret_1».' },
  ];

  const result = rehydrate({ content: messages, sessionId });

  t.true(Array.isArray(result.content));
  if (Array.isArray(result.content)) {
    t.is(result.content.length, 3);
    t.is(result.content[0]!.role, 'system');
    t.is(result.content[0]!.content, 'You are an assistant. Do not leak sk-secret123.');
    t.is(result.content[1]!.role, 'user');
    t.is(result.content[1]!.content, 'My email is alice@example.com');
    t.is(result.content[2]!.role, 'assistant');
    t.is(result.content[2]!.content, 'I will not leak sk-secret123.');
  }
  t.falsy(result.warnings);
});

test('Message[] with hallucinated placeholders aggregates warnings', (t) => {
  const sessionId = seedSession('rh-msg-warn', {
    '«Email_1»': 'alice@example.com',
  });
  const messages = [
    { role: 'user', content: 'Contact «Email_1» or «Phone_99»' },
    { role: 'assistant', content: 'I also see «Secret_99»' },
  ];

  const result = rehydrate({ content: messages, sessionId });

  t.true(Array.isArray(result.content));
  if (Array.isArray(result.content)) {
    t.is(result.content[0]!.content, 'Contact alice@example.com or «Phone_99»');
    t.is(result.content[1]!.content, 'I also see «Secret_99»');
  }

  t.truthy(result.warnings);
  t.is(result.warnings?.length, 2);
  t.regex(result.warnings![0]!, /«Phone_99»/);
  t.regex(result.warnings![1]!, /«Secret_99»/);
});

import { scrub } from '../../src/core/scrub.js';

test('round-trip: scrub(Message[]) -> rehydrate(Message[]) restores originals', (t) => {
  const originalMessages = [
    { role: 'user', content: 'My email is user@example.com' },
    { role: 'assistant', content: 'I have logged user@example.com into the system.' },
  ];

  // 1. Scrub
  const scrubResult = scrub({ content: originalMessages, sessionId: 'rh-round-trip' });
  t.true(Array.isArray(scrubResult.scrubbedContent));

  // 2. Assert scrubbed content has placeholders
  if (Array.isArray(scrubResult.scrubbedContent)) {
    t.regex(scrubResult.scrubbedContent[0]!.content, /«Email_1»/);
    t.notRegex(scrubResult.scrubbedContent[0]!.content, /user@example.com/);
  }

  // 3. Rehydrate
  const rehydrateResult = rehydrate({
    content: scrubResult.scrubbedContent,
    sessionId: scrubResult.sessionId,
  });

  // 4. Assert structure and content is fully restored
  t.true(Array.isArray(rehydrateResult.content));
  if (Array.isArray(rehydrateResult.content)) {
    t.deepEqual(rehydrateResult.content, originalMessages);
  }
  t.falsy(rehydrateResult.warnings);
});
