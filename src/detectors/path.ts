import type { Detector, Finding } from '../types/index.js';

// Linux/macOS absolute path: must start with / and have at least 2 segments.
// Negative lookbehind for '://' prevents matching URL paths like https://example.com/path
const UNIX_PATH_REGEX = /(?<!:\/)(?<![\w~])(\/((?:[a-zA-Z0-9_.@-]+\/)+[a-zA-Z0-9_.@-]*))(?!\w)/g;

// Home directory shorthand: ~/something or ~/.config
// Negative lookbehind ensures we don't catch it as part of a longer word
const HOME_PATH_REGEX = /(?<![\w/])(~\/[a-zA-Z0-9_.@-][a-zA-Z0-9_.@\-/]*)(?![\w])/g;

// Windows absolute path: C:\Users\... or D:\Projects\...
const WIN_PATH_REGEX = /([A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\r\n]*)/g;

export class PathDetector implements Detector {
  readonly name = 'PathDetector';

  detect(text: string): Finding[] {
    const raw: Finding[] = [];

    for (const [regex] of [[UNIX_PATH_REGEX], [HOME_PATH_REGEX], [WIN_PATH_REGEX]] as [RegExp][]) {
      regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(text)) !== null) {
        const value = match[1] ?? match[0];
        const start = match.index + (match[0].length - value.length);
        raw.push({
          category: 'Path',
          span: [start, start + value.length],
          value,
          placeholderPrefix: 'Path',
        });
      }
    }

    // Sort by position, remove exact duplicates
    raw.sort((a, b) => a.span[0] - b.span[0]);
    const findings: Finding[] = [];
    for (const candidate of raw) {
      const duplicate = findings.some(
        (existing) =>
          existing.span[0] === candidate.span[0] && existing.span[1] === candidate.span[1],
      );
      if (!duplicate) {
        findings.push(candidate);
      }
    }

    return findings;
  }
}
