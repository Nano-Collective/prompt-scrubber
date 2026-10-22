import type { Detector, Finding } from '../types/index.js';

// RFC 5322-inspired pattern. Conservative:
// - Requires a dot in the domain (rejects user@localhost)
// - Caps total length at 254 chars (RFC 5321 limit)
// - Accepts letters and digits from any script, so internationalised addresses match
// - The lookbehind admits only the first character of a local-part run. Without
//   it, every position inside a long run of `-`, `%` or `+` starts its own scan to
//   the end of the run, which is quadratic when no `@` follows.
// - A full stop after the address is the end of a sentence, not part of the domain; a
//   full stop followed by more of a name (`a@b.com.x`) is neither, and is skipped.
const EMAIL_REGEX =
  /(?<![\p{L}\p{N}_.%+-])([\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,})(?!\.?[\p{L}\p{N}_])/gu;

// The full address shape is distinctive enough that a match is almost never
// anything else; the residual doubt is placeholder text such as user@test.com.
const EMAIL_CONFIDENCE = 0.95;

export class EmailDetector implements Detector {
  readonly name = 'EmailDetector';

  detect(text: string): Finding[] {
    const findings: Finding[] = [];
    let match: RegExpExecArray | null;

    EMAIL_REGEX.lastIndex = 0;

    while ((match = EMAIL_REGEX.exec(text)) !== null) {
      const value = match[1] ?? match[0];
      if (value.length > 254) continue;

      findings.push({
        category: 'Email',
        span: [match.index, match.index + value.length],
        value,
        placeholderPrefix: 'Email',
        confidence: EMAIL_CONFIDENCE,
        method: 'exact-pattern',
      });
    }

    return findings;
  }
}
