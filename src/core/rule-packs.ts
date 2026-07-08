import type { Detector } from '../types/index.js';
import { loadConfig } from './config.js';
import type { DetectorMetadata } from './detectors.js';

export interface RulePackResult {
  detectors: Detector[];
  metadata: DetectorMetadata[];
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
            loadedDetectors.push(detector);
            metadata.push({
              name: detector.name,
              source: `rule-pack: ${packName}`,
              defaultState: 'on',
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
