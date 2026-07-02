import type { Detector, Finding } from '../types/index.js';

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class CodeTellDetector implements Detector {
  readonly name = 'CodeTellDetector';
  private regex: RegExp | null = null;

  constructor(terms: string[] = []) {
    const validTerms = terms.map((t) => t.trim()).filter((t) => t.length > 0);

    if (validTerms.length > 0) {
      const sortedTerms = [...validTerms].sort((a, b) => b.length - a.length);
      const escapedTerms = sortedTerms.map(escapeRegExp);

      const pattern = `(?<![a-zA-Z0-9_$])(?:${escapedTerms.join('|')})(?![a-zA-Z0-9_$])`;
      this.regex = new RegExp(pattern, 'g');
    }
  }

  detect(text: string): Finding[] {
    if (!this.regex) {
      return [];
    }

    const findings: Finding[] = [];
    let match: RegExpExecArray | null;

    this.regex.lastIndex = 0;

    while ((match = this.regex.exec(text)) !== null) {
      const value = match[0];

      findings.push({
        category: 'CodeTell',
        span: [match.index, match.index + value.length],
        value,
        placeholderPrefix: 'CodeTell',
      });
    }

    return findings;
  }
}
