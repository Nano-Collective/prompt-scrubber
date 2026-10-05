import type { Detector, Finding } from '../types/index.js';

// Both patterns share a layout where group 1 is the full SSN as written.

// Delimited 3-2-4 form with a consistent separator: hyphen or space, not mixed
// and not newline. A spaced SSN with no label still matches here, since a miss
// is a breach while a false positive is reviewable noise.
const SSN_DELIMITED = /(?<!\d)(([0-9]{3})([ -])([0-9]{2})\3([0-9]{4}))(?!\d)/g;

// Separator-tolerant form, gated behind an SSN label within a wider window.
// The label carries the evidence the shape alone cannot.
const SSN_CONTEXTUAL =
  /(?:ssn|social security(?:\s+number)?|tax\s*id)\D{0,40}?(?<![\d-])(([0-9]{3})[ -]?([0-9]{2})[ -]?([0-9]{4}))(?!\d)/gi;

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
        const area = match[2] ?? '';
        const group = regex === SSN_DELIMITED ? (match[4] ?? '') : (match[3] ?? '');
        const serial = regex === SSN_DELIMITED ? (match[5] ?? '') : (match[4] ?? '');
        if (!isValidSsn(area, group, serial)) {
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
