import test from 'ava';
import { addCount } from '../../src/core/counts.js';

test('addCount starts a key at the amount and adds to it afterwards', (t) => {
  const counts: Record<string, number> = {};
  addCount(counts, 'Email');
  addCount(counts, 'Email');
  addCount(counts, 'Phone', 3);
  t.deepEqual(counts, { Email: 2, Phone: 3 });
});

test('addCount treats inherited names as absent and stores __proto__ as a key', (t) => {
  const counts: Record<string, number> = {};
  for (const key of ['constructor', 'toString', '__proto__']) {
    addCount(counts, key);
    addCount(counts, key);
  }
  t.is(Object.keys(counts).length, 3);
  t.is(Object.getOwnPropertyDescriptor(counts, 'constructor')?.value, 2);
  t.is(Object.getOwnPropertyDescriptor(counts, 'toString')?.value, 2);
  t.is(Object.getOwnPropertyDescriptor(counts, '__proto__')?.value, 2);
  t.is(Object.getPrototypeOf(counts), Object.prototype);
});
