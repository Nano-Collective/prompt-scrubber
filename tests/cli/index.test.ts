import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'ava';
import { getVersion, isMainModule } from '../../src/cli/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('getVersion resolves package.json from ../.. correctly', (t) => {
  // Pass current directory, so ../.. points to root prompt-scrubber dir.
  // Assert against the real package version so this test survives version bumps.
  const rootPkg = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf-8'),
  ) as { version: string };
  const v = getVersion(__dirname);
  t.truthy(v);
  t.is(v, rootPkg.version);
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

test('isMainModule matches the same path and rejects other scripts', (t) => {
  t.true(isMainModule(__filename, __filename));
  t.false(isMainModule(path.join(__dirname, 'e2e.test.ts'), __filename));
  t.false(isMainModule(undefined, __filename));
  t.false(isMainModule(path.join(os.tmpdir(), 'does-not-exist.js'), __filename));
});

test('isMainModule resolves a symlink to the script, as a global npm install uses', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-bin-'));
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }));
  const link = path.join(dir, 'prompt-scrub');
  try {
    fs.symlinkSync(__filename, link);
  } catch {
    t.pass('symlinks are not permitted here');
    return;
  }
  t.true(isMainModule(link, __filename));
});
