export interface DetectorMetadata {
  name: string;
  source: string;
  defaultState: 'on' | 'off';
  locales?: string[];
}

const BUILT_IN_DETECTORS: DetectorMetadata[] = [
  { name: 'SecretDetector', source: 'built-in', defaultState: 'on' },
  { name: 'EmailDetector', source: 'built-in', defaultState: 'on' },
  { name: 'UrlDetector', source: 'built-in', defaultState: 'on' },
  { name: 'PathDetector', source: 'built-in', defaultState: 'on' },
  { name: 'PhoneDetector', source: 'built-in', defaultState: 'on' },
  { name: 'AddressDetector', source: 'built-in', defaultState: 'on' },
  { name: 'NameDetector', source: 'built-in', defaultState: 'off' },
  { name: 'CodeTellDetector', source: 'built-in', defaultState: 'off' },
];

import { loadConfig } from './config.js';
import { matchesLocale } from './locale.js';
import { loadConfiguredRulePacks } from './rule-packs.js';

/**
 * Asynchronously loads configured rule-packs and returns the combined
 * metadata of both built-in detectors and rule-pack detectors.
 */
export async function getAvailableDetectorsAsync(): Promise<DetectorMetadata[]> {
  const { metadata } = await loadConfiguredRulePacks();
  const { locale } = loadConfig();

  return [...BUILT_IN_DETECTORS, ...metadata].map((detector) =>
    detector.locales && detector.locales.length > 0
      ? { ...detector, defaultState: matchesLocale(detector.locales, locale) ? 'on' : 'off' }
      : detector,
  );
}
