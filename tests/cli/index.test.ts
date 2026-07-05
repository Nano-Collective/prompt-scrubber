import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'ava';
import { getVersion } from '../../src/cli/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('getVersion resolves package.json from ../.. correctly', (t) => {
  // Pass current directory, so ../.. points to root prompt-scrubber dir
  const v = getVersion(__dirname);
  t.truthy(v);
  t.is(v, '1.0.0'); // The actual package version is 1.0.0
});

test('getVersion falls back to ../package.json when ../.. fails', (t) => {
  // Create a fake structure in temp dir
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-test-'));
  const fakeDistCli = path.join(tmpDir, 'cli');
  fs.mkdirSync(fakeDistCli, { recursive: true });

  // Create package.json at ../ (tmpDir)
  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ version: '2.0.0' }));

  const v = getVersion(fakeDistCli);
  t.is(v, '2.0.0');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('getVersion falls back to 1.0.0 when no package.json is found', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-test-'));
  const fakeDistCli = path.join(tmpDir, 'cli');
  fs.mkdirSync(fakeDistCli, { recursive: true });

  const v = getVersion(fakeDistCli);
  t.is(v, '1.0.0');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
