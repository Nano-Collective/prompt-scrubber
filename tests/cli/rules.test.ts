import test from 'ava';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLI_BIN = join(__dirname, '../../src/cli/index.ts');

function runRulesList(): string {
  // Using tsx directly to run the CLI in tests without a build step
  return execSync(`npx tsx ${CLI_BIN} rules list`, { encoding: 'utf8' });
}

test('CLI: rules list outputs header and built-in detectors', (t) => {
  const output = runRulesList();

  // Check header
  t.true(output.includes('Detector'));
  t.true(output.includes('Source'));
  t.true(output.includes('Default State'));

  // Verify built-in detectors are present
  t.true(output.includes('EmailDetector'));
  t.true(output.includes('SecretDetector'));
  t.true(output.includes('PhoneDetector'));
  t.true(output.includes('AddressDetector'));
});

test('CLI: rules list correctly reports NameDetector as off by default', (t) => {
  const output = runRulesList();

  // Find the NameDetector line
  const lines = output.split('\n');
  const nameDetectorLine = lines.find((line) => line.includes('NameDetector'));

  t.truthy(nameDetectorLine);
  t.true(nameDetectorLine!.includes('off'));
});

test('CLI: rules list correctly reports enabled-by-default detectors', (t) => {
  const output = runRulesList();

  // Find the EmailDetector line
  const lines = output.split('\n');
  const emailDetectorLine = lines.find((line) => line.includes('EmailDetector'));

  t.truthy(emailDetectorLine);
  t.true(emailDetectorLine!.includes('on'));
});

// Future rule-pack tests can be easily added here by mocking or configuring custom detectors
