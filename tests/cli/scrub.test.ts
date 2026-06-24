import test from 'ava';
import { handleScrub } from '../../src/cli/commands/scrub.js';

test('handleScrub processes text and returns result', (t) => {
  const result = handleScrub('My email is test@example.com', {});
  t.is(result.scrubbedContent, 'My email is Email_1');
  t.truthy(result.sessionId);
});

test('handleScrub respects disabled detectors', (t) => {
  const result = handleScrub('My email is test@example.com', { disable: 'EmailDetector' });
  t.is(result.scrubbedContent, 'My email is test@example.com');
});
