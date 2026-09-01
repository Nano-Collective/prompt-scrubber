import type { Detector, Finding } from '../types/index.js';

// Both patterns share a group layout: 1 = the full SSN as written, 2/3/4 = area/group/serial.

// Hyphenated 3-2-4 form — unambiguous enough to stand on its own.
const SSN_DELIMITED = /(?<!\d)(([0-9]{3})-([0-9]{2})-([0-9]{4}))(?!\d)/g;

// Space-separated and continuous forms, only when an SSN label sits before them.
// Unanchored, "123456789" and "100 20 3000" are far more likely to be an order ID,
// error code, or list of quantities than an SSN. The label is consumed by the match,
// so the finding is anchored on the digits alone.
const SSN_CONTEXTUAL =
  /(?:ssn|social security(?:\s+number)?|tax\s*id)\D{0,10}(?<!\d)(([0-9]{3})[ ]?([0-9]{2})[ ]?([0-9]{4}))(?!\d)/gi;

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
