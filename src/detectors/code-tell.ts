import type { Detector, Finding } from '../types/index.js';

/**
 * Maximum length of any single user-supplied term. Bound the per-term
 * input so a maliciously long term cannot force pathological matching
 * downstream.
 */
const MAX_TERM_LENGTH = 64;

/**
 * Maximum number of terms we'll accept. With O(n) scans per term,
 * keeping the term count small makes detection cost predictable.
 */
const MAX_TERM_COUNT = 64;

const IDENTIFIER_CHAR = /[a-zA-Z0-9_$]/;

/**
 * Returns true if `idx` in `text` is the position immediately after a
 * non-identifier character (i.e., the start of an identifier). The very
 * start of the input, or any position right after a non-identifier
 * character, counts as an identifier start.
 */
function isIdentifierStart(text: string, idx: number): boolean {
  if (idx <= 0) {
    return true;
  }
  const prev = text[idx - 1] ?? '';
  return !IDENTIFIER_CHAR.test(prev);
}

/**
 * Returns true if the position immediately after a match is the end of
 * an identifier (i.e., the character at `idx` is not an identifier char,
 * or `idx` is past the end of the input).
 */
function isIdentifierEnd(text: string, idx: number): boolean {
  if (idx >= text.length) {
    return true;
  }
  return !IDENTIFIER_CHAR.test(text[idx] ?? '');
}

export class CodeTellDetector implements Detector {
  readonly name = 'CodeTellDetector';
  private terms: string[] = [];

  constructor(terms: string[] = []) {
    this.terms = terms
      .map((t) => t.trim())
      .filter((t) => t.length > 0 && t.length <= MAX_TERM_LENGTH)
      .slice(0, MAX_TERM_COUNT);
  }

  detect(text: string): Finding[] {
    if (this.terms.length === 0) {
      return [];
    }

    const findings: Finding[] = [];

    let cursor = 0;
    while (cursor < text.length) {
      // Only try to match at the start of an identifier; otherwise skip.
      if (!isIdentifierStart(text, cursor)) {
        cursor += 1;
        continue;
      }

      let bestMatch: { start: number; length: number } | null = null;

      for (const term of this.terms) {
        if (term.length === 0) continue;
        if (!text.startsWith(term, cursor)) continue;
        // Require a word boundary on the right too, so `var` doesn't
        // match inside `variable`.
        if (!isIdentifierEnd(text, cursor + term.length)) continue;
        // Prefer the longest match at this cursor position.
        if (!bestMatch || term.length > bestMatch.length) {
          bestMatch = { start: cursor, length: term.length };
        }
      }

      if (bestMatch) {
        const { start, length } = bestMatch;
        const endIdx = start + length;
        findings.push({
          category: 'CodeTell',
          span: [start, endIdx],
          value: text.slice(start, endIdx),
          placeholderPrefix: 'CodeTell',
        });
        cursor = endIdx;
      } else {
        cursor += 1;
      }
    }

    return findings;
  }
}
