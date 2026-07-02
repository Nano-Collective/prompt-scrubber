export interface DetectorMetadata {
  name: string;
  source: string;
  defaultState: 'on' | 'off';
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

/**
 * Returns metadata for all available detectors.
 * Structured to allow easy integration of rule-pack (custom) detectors in the future.
 */
export function getAvailableDetectors(): DetectorMetadata[] {
  return [...BUILT_IN_DETECTORS];
}
