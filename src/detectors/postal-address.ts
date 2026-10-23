import type { Detector, Finding } from '../types/index.js';

// Conservative matching only: number + word(s) + street suffix, then an optional
// compass direction, unit and `, City, ST 12345` tail. The tail needs a ZIP code, so
// prose such as "Main St, then go on" is never mistaken for a city and state.
// Examples: 123 Main Street, 45 Oak Road, 1600 Pennsylvania Ave. NW, Washington, DC 20500,
// 10 Downing St, 221B Baker St.
const STREET = String.raw`\b\d{1,6}[a-z]?(?:\s+(?!\d+\b)[a-z0-9.'-]+){1,4}\s+(?:street|st|road|rd|avenue|ave|boulevard|blvd|lane|ln|drive|dr|court|ct|place|pl|square|sq|terrace|ter)\b\.?`;
const DIRECTION = String.raw`(?:\s+(?:ne|nw|se|sw|n|s|e|w)\b\.?(?=[\s,]|$))?`;
const UNIT = String.raw`(?:,?\s+(?:(?:apt|apartment|suite|ste|unit)\.?\s*#?|#)(?=[a-z0-9-]*\d)[a-z0-9-]+)?`;
const LOCALITY = String.raw`(?:,\s*[a-z][a-z.'-]*(?:\s+[a-z][a-z.'-]*){0,2},?\s+[a-z]{2}\s+\d{5}(?:-\d{4})?\b)?`;
const ADDRESS_REGEX = new RegExp(STREET + DIRECTION + UNIT + LOCALITY, 'gi');

// Street-suffix matching is a heuristic: "5 Church St" is an address, but so is
// the shape of "12 Monkeys Ave" in prose. Deliberately below the 0.8 mark.
const ADDRESS_CONFIDENCE = 0.7;

export class PostalAddressDetector implements Detector {
  readonly name = 'AddressDetector';

  detect(text: string): Finding[] {
    const findings: Finding[] = [];
    let match: RegExpExecArray | null;

    ADDRESS_REGEX.lastIndex = 0;

    while ((match = ADDRESS_REGEX.exec(text)) !== null) {
      const value = match[0];

      findings.push({
        category: 'Address',
        span: [match.index, match.index + value.length],
        value,
        placeholderPrefix: 'Address',
        confidence: ADDRESS_CONFIDENCE,
        method: 'heuristic',
      });
    }

    return findings;
  }
}
