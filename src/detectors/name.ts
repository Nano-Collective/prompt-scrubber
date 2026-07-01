import type { Detector, Finding } from '../types/index.js';

// Matches words starting with a capital letter, optionally followed by more capitalized words.
// e.g., "Alice", "John Doe", "San Francisco"
const NAME_REGEX = /\b[A-Z][a-z]+(?: [A-Z][a-z]+)*\b/g;

// A small built-in allowlist for strict mode covering common first names, countries,
// languages, and widely recognized product names.
const ALLOWLIST = new Set([
  // Common first names
  'john',
  'jane',
  'michael',
  'sarah',
  'david',
  'emily',
  'james',
  'jessica',
  // Countries
  'united states',
  'canada',
  'mexico',
  'united kingdom',
  'france',
  'germany',
  'japan',
  'australia',
  'india',
  'china',
  // Languages
  'english',
  'spanish',
  'french',
  'german',
  'japanese',
  'chinese',
  'hindi',
  'arabic',
  // Widely recognized product/company names
  'apple',
  'microsoft',
  'google',
  'amazon',
  'meta',
  'facebook',
  'twitter',
  'openai',
  // Days & Months
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
]);

export class NameDetector implements Detector {
  readonly name = 'NameDetector';
  private strict: boolean;

  constructor(strict = false) {
    this.strict = strict;
  }

  detect(text: string): Finding[] {
    const findings: Finding[] = [];
    let match: RegExpExecArray | null;

    NAME_REGEX.lastIndex = 0;

    while ((match = NAME_REGEX.exec(text)) !== null) {
      const value = match[0];

      // In strict mode, we skip matches that contain an allowlisted word
      if (this.strict) {
        const words = value.toLowerCase().split(' ');
        if (words.some((w) => ALLOWLIST.has(w))) {
          continue;
        }
      }

      findings.push({
        category: 'Name',
        span: [match.index, match.index + value.length],
        value,
        placeholderPrefix: 'Name',
      });
    }

    return findings;
  }
}
