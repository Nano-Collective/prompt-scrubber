import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'ava';
import { loadConfiguredRulePacks } from '../../src/core/rule-packs.js';
import { scrub } from '../../src/core/scrub.js';

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

/**
 * Writes a throwaway config dir containing `pack.mjs` and points
 * PROMPT_SCRUB_CONFIG_DIR at it. Returns a cleanup function.
 */
function withPack(label: string, source: string): { dir: string; cleanup: () => void } {
  const dir = path.join(os.tmpdir(), `prompt-scrub-test-${label}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });

  const packPath = path.join(dir, 'pack.mjs');
  fs.writeFileSync(packPath, source, 'utf8');
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ rulePacks: [pathToFileURL(packPath).href] }),
    'utf8',
  );

  process.env.PROMPT_SCRUB_CONFIG_DIR = dir;

  return {
    dir,
    cleanup: () => {
      delete process.env.PROMPT_SCRUB_CONFIG_DIR;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test.serial('loadConfiguredRulePacks keeps a well-formed locales array', async (t) => {
  const { cleanup } = withPack(
    'locales-ok',
    'export const detectors = [{ name: "OkDetector", locales: ["de-DE", "de-AT"], detect: () => [] }];',
  );

  const { detectors, metadata } = await loadConfiguredRulePacks();

  t.deepEqual(detectors[0]?.locales, ['de-DE', 'de-AT']);
  t.deepEqual(metadata[0]?.locales, ['de-DE', 'de-AT']);

  cleanup();
});

test.serial('loadConfiguredRulePacks drops a locales field that is not an array', async (t) => {
  const { cleanup } = withPack(
    'locales-string',
    'export const detectors = [{ name: "StringLocaleDetector", locales: "de-DE", detect: () => [] }];',
  );

  const { detectors, metadata } = await loadConfiguredRulePacks();

  // The detector survives; only the unusable field is dropped, so nothing
  // downstream calls `.some`/`.join` on a string.
  t.is(detectors.length, 1);
  t.is(detectors[0]?.name, 'StringLocaleDetector');
  t.is(detectors[0]?.locales, undefined);
  t.is(metadata[0]?.locales, undefined);

  cleanup();
});

test.serial('loadConfiguredRulePacks drops non-string entries inside locales', async (t) => {
  const { cleanup } = withPack(
    'locales-mixed',
    'export const detectors = [{ name: "MixedLocaleDetector", locales: ["de-DE", 42, null, "  "], detect: () => [] }];',
  );

  const { detectors, metadata } = await loadConfiguredRulePacks();

  t.deepEqual(detectors[0]?.locales, ['de-DE']);
  t.deepEqual(metadata[0]?.locales, ['de-DE']);

  cleanup();
});

test.serial('loadConfiguredRulePacks drops an empty locales array', async (t) => {
  const { cleanup } = withPack(
    'locales-empty-strings',
    'export const detectors = [{ name: "BlankLocaleDetector", locales: [""], detect: () => [] }];',
  );

  const { detectors } = await loadConfiguredRulePacks();

  t.is(detectors[0]?.locales, undefined);

  cleanup();
});

test.serial('a sanitised class-based detector keeps its prototype detect()', async (t) => {
  const { cleanup } = withPack(
    'locales-class',
    `class ClassDetector {
       constructor() {
         this.name = 'ClassDetector';
         this.locales = 'de-DE';
       }
       detect(text) {
         return text.includes('hit')
           ? [{ category: 'Hit', span: [0, 3], value: 'hit', placeholderPrefix: 'Hit' }]
           : [];
       }
     }
     export const detectors = [new ClassDetector()];`,
  );

  const { detectors } = await loadConfiguredRulePacks();

  t.is(detectors[0]?.locales, undefined);
  t.is(detectors[0]?.detect('hit').length, 1);

  cleanup();
});

test.serial('a pack with malformed locales still scrubs instead of throwing', async (t) => {
  const { cleanup } = withPack(
    'locales-scrub',
    `export const detectors = [{
       name: 'BadLocaleDetector',
       locales: 'de-DE',
       detect: (text) => {
         const idx = text.indexOf('SECRET');
         return idx === -1
           ? []
           : [{ category: 'Custom', span: [idx, idx + 6], value: 'SECRET', placeholderPrefix: 'Custom' }];
       },
     }];`,
  );

  const { detectors } = await loadConfiguredRulePacks();

  // Locale-agnostic after sanitising, so it runs with and without a locale.
  t.is(
    scrub({ content: 'a SECRET b', options: { customDetectors: detectors } }).scrubbedContent,
    'a «Custom_1» b',
  );
  t.is(
    scrub({ content: 'a SECRET b', options: { customDetectors: detectors, locale: 'de-DE' } })
      .scrubbedContent,
    'a «Custom_1» b',
  );

  cleanup();
});
