import { loadConfig } from './config.js';
import { matchesLocale } from './locale.js';
import { loadConfiguredRulePacks, type RulePackFailure } from './rule-packs.js';

export interface DetectorMetadata {
  name: string;
  source: string;
  /** The detector's own default, independent of any locale. */
  defaultState: 'on' | 'off';
  locales?: string[];
  /**
   * Whether the resolved locale lets this detector run. Only set for
   * locale-scoped detectors — a detector without `locales` is never gated.
   */
  localeActive?: boolean;
}

const BUILT_IN_DETECTORS: DetectorMetadata[] = [
  { name: 'SecretDetector', source: 'built-in', defaultState: 'on' },
  { name: 'CreditCardDetector', source: 'built-in', defaultState: 'on' },
  { name: 'IbanDetector', source: 'built-in', defaultState: 'on' },
  { name: 'SsnDetector', source: 'built-in', defaultState: 'on' },
  { name: 'EmailDetector', source: 'built-in', defaultState: 'on' },
  { name: 'UrlDetector', source: 'built-in', defaultState: 'on' },
  { name: 'PathDetector', source: 'built-in', defaultState: 'on' },
  { name: 'IpAddressDetector', source: 'built-in', defaultState: 'on' },
  { name: 'PhoneDetector', source: 'built-in', defaultState: 'on' },
  { name: 'AddressDetector', source: 'built-in', defaultState: 'on' },
  { name: 'NameDetector', source: 'built-in', defaultState: 'off' },
  { name: 'CodeTellDetector', source: 'built-in', defaultState: 'off' },
];

/**
 * Asynchronously loads configured rule-packs and returns the combined
 * metadata of both built-in detectors and rule-pack detectors.
 *
 * `locale` resolves the locale gate, so callers can preview another locale
 * than the configured one. Omit it to fall back to the configuration.
 *
 * `onRulePackFailures` receives the rule packs that failed to import, so the
 * caller can report them; this module stays silent.
 */
export async function getAvailableDetectorsAsync(
  locale?: string,
  onRulePackFailures?: (failed: RulePackFailure[]) => void,
): Promise<DetectorMetadata[]> {
  const { metadata, failed } = await loadConfiguredRulePacks();
  onRulePackFailures?.(failed);
  const activeLocale = locale ?? loadConfig().locale;

  return [...BUILT_IN_DETECTORS, ...metadata].map((detector) =>
    detector.locales && detector.locales.length > 0
      ? { ...detector, localeActive: matchesLocale(detector.locales, activeLocale) }
      : detector,
  );
}
