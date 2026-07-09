import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'ava';
import { rehydrate } from '../../src/core/rehydrate.js';
import { scrub } from '../../src/core/scrub.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const tmpConfigDir = path.join(__dirname, '.tmp-config-integration');

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

test('MVP round-trip: scrub then rehydrate restores the original string exactly', (t) => {
  const original =
    'My email is akram@example.com and my key is sk-aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890abc';

  // Step 1: Scrub
  const scrubResult = scrub({ content: original });
  const scrubbed = scrubResult.scrubbedContent as string;

  // Verify PII was removed
  t.false(scrubbed.includes('akram@example.com'));
  t.false(scrubbed.includes('sk-'));
  t.regex(scrubbed, /Email_\d/);
  t.regex(scrubbed, /Secret_\d/);

  // Step 2: Rehydrate using the same session
  const rehydrateResult = rehydrate({
    content: scrubbed,
    sessionId: scrubResult.sessionId,
  });

  // The original string must be fully restored
  t.is(rehydrateResult.content, original);
  t.falsy(rehydrateResult.warnings);
});

test('multi-type round-trip: email + URL + path all restored', (t) => {
  const original =
    'Contact alice@corp.com via https://api.corp.com/v1/users from /home/alice/notes.txt';

  const { scrubbedContent, sessionId } = scrub({ content: original });
  const scrubbed = scrubbedContent as string;

  t.false(scrubbed.includes('alice@corp.com'));
  t.false(scrubbed.includes('https://api.corp.com'));
  t.false(scrubbed.includes('/home/alice/notes.txt'));

  const { content: restored, warnings } = rehydrate({ content: scrubbed, sessionId });
  t.is(restored, original);
  t.falsy(warnings);
});

test('hallucinated placeholder does not corrupt the rest of a rehydration', (t) => {
  const original = 'Email me at real@example.com';

  const { scrubbedContent, sessionId } = scrub({ content: original });
  const scrubbed = scrubbedContent as string;

  // Simulate model inventing an extra placeholder
  const modelResponse = `${scrubbed} and also «Phone_99»`;

  const { content: restored, warnings } = rehydrate({ content: modelResponse, sessionId });

  // The real placeholder is restored; the hallucinated one is left and warned
  t.true(restored.includes('real@example.com'));
  t.true(restored.includes('«Phone_99»'));
  t.is(warnings?.length, 1);
  t.regex(warnings![0]!, /«Phone_99»/);
});

test('Message[] round-trip: scrub preserves structure and rehydrate restores content', (t) => {
  const messages = [
    { role: 'user', content: 'My email is user@example.com' },
    { role: 'assistant', content: 'I understand. Let me help.' },
  ];

  const { scrubbedContent, sessionId } = scrub({ content: messages });
  const scrubbedMessages = scrubbedContent as typeof messages;

  t.is(scrubbedMessages[0]?.role, 'user');
  t.is(scrubbedMessages[0]?.content, 'My email is «Email_1»');
  t.is(scrubbedMessages[1]?.content, 'I understand. Let me help.');

  // Rehydrate the user message
  const { content: restored } = rehydrate({
    content: scrubbedMessages[0]!.content,
    sessionId,
  });
  t.is(restored, 'My email is user@example.com');
});
