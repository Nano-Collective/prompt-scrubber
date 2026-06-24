import test from 'ava';
import { handleInspect, formatInspectOutput } from '../../src/cli/commands/inspect.js';

test('handleInspect finds entities without side effects', (t) => {
  const findings = handleInspect('My email is test@example.com', {});
  t.is(findings.length, 1);
  t.is(findings[0]?.category, 'Email');
});

test('formatInspectOutput formats findings', (t) => {
  const findings = handleInspect('My email is test@example.com', {});
  const output = formatInspectOutput(findings);
  t.true(output.includes('test@example.com'));
  t.true(output.includes('Email_1'));
});

test('formatInspectOutput handles empty findings', (t) => {
  const output = formatInspectOutput([]);
  t.true(output.includes('No sensitive entities detected'));
});
