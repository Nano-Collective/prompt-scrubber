import type { Detector } from '../types/index.js';
import { loadConfig } from './config.js';
import type { DetectorMetadata } from './detectors.js';

export interface RulePackResult {
  detectors: Detector[];
  metadata: DetectorMetadata[];
}

/**
 * `locales` arrives from third-party code, so it is validated like `name` and
 * `detect` are. Anything that is not a non-empty array of strings is dropped,
 * leaving a locale-agnostic detector rather than a crash later on — a pack
 * shipping `locales: 'de-DE'` would otherwise reach `matchesLocale`, where
 * `supported.some` is not a function, and `rules list`, where `.join` is not.
 *
 * A sanitised detector is re-exposed as a delegating object rather than a
 * spread copy, so class-based detectors keep their prototype `detect`.
 */
function withValidatedLocales(detector: Detector): Detector {
  const declared: unknown = detector.locales;
  if (declared === undefined) return detector;

  const locales = Array.isArray(declared)
    ? declared.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0)
    : [];

  if (Array.isArray(declared) && locales.length === declared.length) return detector;

  const sanitised: Detector = { name: detector.name, detect: (text) => detector.detect(text) };
  if (locales.length > 0) {
    sanitised.locales = locales;
  }
  return sanitised;
}

/**
 * Loads rule packs configured in the prompt-scrub environment.
 * Expects external npm packages to export either a default array of Detectors,
 * or a named 'detectors' export.
 */
export async function loadConfiguredRulePacks(): Promise<RulePackResult> {
  const config = loadConfig();
  if (!config.rulePacks || config.rulePacks.length === 0) {
    return { detectors: [], metadata: [] };
  }

  const loadedDetectors: Detector[] = [];
  const metadata: DetectorMetadata[] = [];

  for (const packName of config.rulePacks) {
    try {
      // Dynamically load the npm package
      const mod = await import(packName);

      let packDetectors: Detector[] = [];

      if (Array.isArray(mod.detectors)) {
        packDetectors = mod.detectors;
      } else if (Array.isArray(mod.default)) {
        packDetectors = mod.default;
      } else if (mod.default?.detectors && Array.isArray(mod.default.detectors)) {
        packDetectors = mod.default.detectors;
      }

      if (packDetectors.length > 0) {
        for (const detector of packDetectors) {
          // Silently skip invalid detectors (missing 'name' or 'detect()').
          // A library must not write to stdout/stderr — doing so corrupts
          // Ink/TUI rendering in consumers such as nanocoder.
          if (typeof detector.detect === 'function' && typeof detector.name === 'string') {
            const validated = withValidatedLocales(detector);
            loadedDetectors.push(validated);
            metadata.push({
              name: validated.name,
              source: `rule-pack: ${packName}`,
              defaultState: 'on',
              ...(validated.locales && validated.locales.length > 0
                ? { locales: validated.locales }
                : {}),
            });
          }
        }
      }
    } catch {
      // Rule pack could not be loaded (e.g. not installed). Best-effort:
      // skip it silently rather than logging, for the reason noted above.
    }
  }

  return { detectors: loadedDetectors, metadata };
}
