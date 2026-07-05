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
          if (typeof detector.detect === 'function' && typeof detector.name === 'string') {
            loadedDetectors.push(detector);
            metadata.push({
              name: detector.name,
              source: `rule-pack: ${packName}`,
              defaultState: 'on',
            });
          } else {
            console.warn(
              `[prompt-scrub] Warning: Rule pack "${packName}" exported an invalid detector missing 'name' or 'detect()'.`,
            );
          }
        }
      } else {
        console.warn(
          `[prompt-scrub] Warning: Rule pack "${packName}" did not export any valid detectors.`,
        );
      }
    } catch (e) {
      console.warn(
        `[prompt-scrub] Warning: Could not load rule pack "${packName}". Is it installed? Error: ${(e as Error).message}`,
      );
    }
  }

  return { detectors: loadedDetectors, metadata };
}
