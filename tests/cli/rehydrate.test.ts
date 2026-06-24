import test from 'ava';
import { handleRehydrate } from '../../src/cli/commands/rehydrate.js';
import { writeSessionMap } from '../../src/session/storage.js';

test('handleRehydrate restores placeholder', (t) => {
  writeSessionMap('cli-rh-test', { Email_1: 'cli@example.com' });
  const result = handleRehydrate('Send to Email_1', { sessionId: 'cli-rh-test' });
  t.is(result.content, 'Send to cli@example.com');
});
