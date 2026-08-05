import test from 'ava';
import { inspect } from '../../src/core/inspect.js';

test('inspect returns collision-resolved findings without creating a session', (t) => {
  const result = inspect({ content: 'Contact alice@example.com at https://example.com/docs' });

  t.is(result.findings.length, 2);
  t.deepEqual(result.categories, { Email: 1, Url: 1 });
  t.is(result.findings[0]?.value, 'alice@example.com');
  t.is(result.findings[1]?.value, 'https://example.com/docs');
});

test('inspect accepts the same detector options as scrub', (t) => {
  const result = inspect({
    content: 'Contact alice@example.com at https://example.com/docs.',
    options: { disabledDetectors: ['UrlDetector'] },
  });

  t.deepEqual(result.categories, { Email: 1 });
  t.is(result.findings.length, 1);
});
