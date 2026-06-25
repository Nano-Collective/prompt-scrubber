import type { Detector, Finding } from '../types/index.js';

// RFC 5322-inspired pattern. Conservative:
// - Requires a dot in the domain (rejects user@localhost)
// - Caps total length at 254 chars (RFC 5321 limit)
const EMAIL_REGEX = /(?<![.\w])([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})(?![.\w])/g;

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
      });
    }

    return findings;
  }
}
