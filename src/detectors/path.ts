import type { Detector, Finding } from '../types/index.js';

// Linux/macOS absolute path: must start with / and have at least 2 segments.
// Negative lookbehind for '://' prevents matching URL paths like https://example.com/path
const UNIX_PATH_REGEX = /(?<!:\/)(?<![\w~])(\/((?:[a-zA-Z0-9_.@-]+\/)+[a-zA-Z0-9_.@-]*))(?!\w)/g;

// Home directory shorthand: ~/something or ~/.config
// Negative lookbehind ensures we don't catch it as part of a longer word
const HOME_PATH_REGEX = /(?<![\w/])(~\/[a-zA-Z0-9_.@-][a-zA-Z0-9_.@\-/]*)(?![\w])/g;

// Windows absolute path: C:\Users\... or D:\Projects\...
//
// Spaces are the hard part: `C:\Program Files` and `C:\Users\john smith\creds.json`
// are real paths, but `C:\app\cfg.ini owner alice@corp.com` is a path followed by
// prose. The two errors are not symmetric. Over-matching is safe — collision
// resolution narrows a Path finding to whatever the email or secret inside it
// does not cover, so the worst case is over-redaction. Under-matching is the bug
// in #123: the tail the match dropped goes to the model in cleartext, next to a
// placeholder that makes the line look scrubbed. So when in doubt, keep going.
//
// The composed source below is assembled once at module load, not per call.

// One character that may appear inside a path segment, excluding whitespace and
// the characters Windows forbids in a filename.
const WIN_SEG_CHAR = String.raw`[^\s\\/:*?"<>|]`;

// A file extension at the end of a segment, e.g. `.ini`, `.xlsx`.
const WIN_EXT = String.raw`\.[A-Za-z0-9]{1,8}`;

// A space that continues the path rather than ending it. Any one of:
//
//   (a) the next token still contains a backslash, so more path demonstrably
//       follows — "john smith\AppData", "my project\src", "jan 2026\payroll";
//   (b) the next token looks like a path component: capitalised, a digit or an
//       opening paren — "Program Files", "John Doe", "Studio 14.0", "(x86)";
//   (c) the next token carries a file extension, so it reads as the filename the
//       path ends at — "client list.csv", "quarterly report.xlsx".
//
// (b) and (c) are blocked directly after an extension: once a segment ends in
// `.ini`/`.txt` the path is already complete, so what follows is a sentence
// rather than more path ("out.txt Failed to start"). (a) is allowed even there,
// because a backslash in the next token outweighs that signal.
//
// Each lookahead only reaches to the end of the current token, so a backslash
// later on the line cannot reach back and re-open the match: in
// "C:\a\b.txt to D:\c\d.txt" the token after the space is just "to".
const WIN_PATH_SPACE = [
  String.raw`[ ](?=${WIN_SEG_CHAR}*\\)`,
  `(?<!${WIN_EXT})[ ](?=[A-Z0-9(])`,
  `(?<!${WIN_EXT})[ ](?=${WIN_SEG_CHAR}*${WIN_EXT}(?!${WIN_SEG_CHAR}))`,
].join('|');

// Quoted form — inside double quotes the path is already delimited, so spaces
// are allowed freely. The quotes are matched by lookaround rather than consumed,
// which keeps the captured value flush with its span.
const WIN_PATH_QUOTED = String.raw`(?<=")[A-Za-z]:\\[^"\r\n]*(?=")`;

// Unquoted form — a drive, then path characters, separators and continuing
// spaces. The three alternatives start with disjoint characters, so each step
// consumes exactly one character with nothing to backtrack into.
const WIN_PATH_UNQUOTED = String.raw`[A-Za-z]:\\(?:${WIN_SEG_CHAR}|\\|${WIN_PATH_SPACE})*`;

const WIN_PATH_REGEX = new RegExp(`(${WIN_PATH_QUOTED}|${WIN_PATH_UNQUOTED})`, 'g');

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

    // The regexes are mutually exclusive by prefix (/, ~/, Drive:\)
    // so they will not yield identical or overlapping spans.
    raw.sort((a, b) => a.span[0] - b.span[0]);
    return raw;
  }
}
