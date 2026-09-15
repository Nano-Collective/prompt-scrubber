import type { Detector, Finding } from '../types/index.js';

// Both patterns share a group layout: 1 = the full SSN as written, 2/3/4 = area/group/serial.

// Delimited 3-2-4 form. Hyphen-only, and deliberately so: accepting a space here also
// accepts any 3-2-4 run of numbers, and `Latency was 100 20 3000 ms` is far more often
// a table row or a measurement than an SSN. Real SSNs are written with hyphens.
const SSN_DELIMITED = /(?<!\d)(([0-9]{3})-([0-9]{2})-([0-9]{4}))(?!\d)/g;

// Separator-tolerant form, gated behind a nearby SSN label. The label carries the
// evidence the shape alone cannot, so spaces and the continuous form are safe here.
// The label is consumed by the match, so the finding is anchored on the digits alone.
const SSN_CONTEXTUAL =
  /(?:ssn|social security(?:\s+number)?|tax\s*id)\D{0,10}?(?<![\d-])(([0-9]{3})[ -]?([0-9]{2})[ -]?([0-9]{4}))(?!\d)/gi;

/**
 * Validates whether the 3 components of an SSN satisfy Social Security Administration rules.
 */
function isValidSsn(area: string, group: string, serial: string): boolean {
  return (
    area !== '000' && area !== '666' && !area.startsWith('9') && group !== '00' && serial !== '0000'
  );
}

export class SsnDetector implements Detector {
  readonly name = 'SsnDetector';

  detect(text: string): Finding[] {
    const raw: Finding[] = [];
    // A labelled hyphenated SSN satisfies both patterns at the same span, so the
    // findings are deduplicated on their start offset.
    const seen = new Set<number>();

    for (const regex of [SSN_DELIMITED, SSN_CONTEXTUAL]) {
      regex.lastIndex = 0;
      let match: RegExpExecArray | null;

      while ((match = regex.exec(text)) !== null) {
        if (!isValidSsn(match[2] ?? '', match[3] ?? '', match[4] ?? '')) {
          continue;
        }

        // The contextual pattern also consumes the label, which is not part of the finding.
        const value = match[1] ?? match[0];
        const start = match.index + match[0].length - value.length;
        if (seen.has(start)) {
          continue;
        }
        seen.add(start);

        raw.push({
          category: 'Ssn',
          span: [start, start + value.length],
          value,
          placeholderPrefix: 'Ssn',
        });
      }
    }

    return raw.sort((a, b) => a.span[0] - b.span[0]);
  }
}
