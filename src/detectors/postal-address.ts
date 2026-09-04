import type { Detector, Finding } from '../types/index.js';

// Conservative matching only: number + word(s) + street suffix.
// Examples: 123 Main Street, 45 Oak Road, 1600 Pennsylvania Ave., 10 Downing St, 221B Baker St.
const ADDRESS_REGEX =
  /\b\d{1,6}[A-Za-z]?\s+[A-Za-z0-9\s.,'-]+?\b(?:street|st|road|rd|avenue|ave|boulevard|blvd|lane|ln|drive|dr|court|ct|place|pl|square|sq|terrace|ter)\b\.?/gi;

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
