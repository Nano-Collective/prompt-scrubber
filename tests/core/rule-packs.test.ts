import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'ava';
import { loadConfiguredRulePacks } from '../../src/core/rule-packs.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test.serial('loadConfiguredRulePacks loads a valid mock pack', async (t) => {
  // We can override the process.cwd() or PROMPT_SCRUB_CONFIG_DIR, but since loadConfig reads
  // from package.json in process.cwd(), it's easier to mock loadConfig or create a temp config.
  // Actually, loadConfig is not easily mocked. Let's create a temporary config dir.

  const tmpDir = path.join(os.tmpdir(), `prompt-scrub-test-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  // Set PROMPT_SCRUB_CONFIG_DIR to override global config
  process.env.PROMPT_SCRUB_CONFIG_DIR = tmpDir;

  // Create mock pack in temp dir
  const mockPackPath = path.join(tmpDir, 'mock-pack.js');
  fs.writeFileSync(
    mockPackPath,
    'export const detectors = [{ name: "MockPackDetector", detect: () => [] }];',
    'utf8',
  );

  // Create config.json
  fs.writeFileSync(
    path.join(tmpDir, 'config.json'),
    JSON.stringify({ rulePacks: [mockPackPath] }),
    'utf8',
  );

  const { detectors, metadata } = await loadConfiguredRulePacks();

  t.is(detectors.length, 1);
  t.is(detectors[0]?.name, 'MockPackDetector');

  t.is(metadata.length, 1);
  t.is(metadata[0]?.name, 'MockPackDetector');
  t.true(metadata[0]?.source.includes('mock-pack'));
  t.is(metadata[0]?.defaultState, 'on');

  // Cleanup
  delete process.env.PROMPT_SCRUB_CONFIG_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test.serial('loadConfiguredRulePacks handles missing package gracefully', async (t) => {
  const tmpDir = path.join(os.tmpdir(), `prompt-scrub-test-missing-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  process.env.PROMPT_SCRUB_CONFIG_DIR = tmpDir;

  fs.writeFileSync(
    path.join(tmpDir, 'config.json'),
    JSON.stringify({ rulePacks: ['this-package-does-not-exist'] }),
    'utf8',
  );

  const { detectors, metadata } = await loadConfiguredRulePacks();

  t.is(detectors.length, 0);
  t.is(metadata.length, 0);

  // Cleanup
  delete process.env.PROMPT_SCRUB_CONFIG_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
