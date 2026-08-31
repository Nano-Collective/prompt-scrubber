import type { Detector, Finding } from '../types/index.js';

// Linux/macOS absolute path: must start with / and have at least 2 segments.
// Negative lookbehind for '://' prevents matching URL paths like https://example.com/path
const UNIX_PATH_REGEX = /(?<!:\/)(?<![\w~])(\/((?:[a-zA-Z0-9_.@-]+\/)+[a-zA-Z0-9_.@-]*))(?!\w)/g;

// Home directory shorthand: ~/something or ~/.config
// Negative lookbehind ensures we don't catch it as part of a longer word
const HOME_PATH_REGEX = /(?<![\w/])(~\/[a-zA-Z0-9_.@-][a-zA-Z0-9_.@\-/]*)(?![\w])/g;

// Windows absolute path: C:\Users\... or D:\Projects\...
//
// Spaces are the hard part: `C:\Program Files` and `C:\Users\John Doe` are real
// paths, but `C:\app\cfg.ini owner alice@corp.com` is a path followed by prose.
// Letting every segment run over spaces makes the match swallow the rest of the
// line, which then loses collision resolution to the email/secret inside it and
// leaves the path itself in cleartext. Forbidding spaces outright truncates the
// genuine paths above and leaks their tail. So the two forms are matched
// separately.

// One character that may appear inside a path segment, excluding whitespace and
// the characters Windows forbids in a filename.
const WIN_SEG_CHAR = String.raw`[^\s\\/:*?"<>|]`;

// A space followed by a token that still looks like part of a path — capitalised,
// a digit, or an opening paren, as in "Program Files", "John Doe", "Studio 14.0",
// "Program Files (x86)". Lowercase words read as prose and end the match, which
// is what keeps "cfg.ini owner alice@corp.com" out of it.
//
// Blocked directly after a file extension: once a segment ends in `.ini`/`.txt`
// the path is complete, so a capitalised word after it ("out.txt Failed to …")
// is a sentence rather than more path. Capped at four tokens to bound how much
// prose a pathological line can pull in.
const WIN_SEG_CONT = String.raw`(?:(?<!\.[A-Za-z0-9]{1,8}) [A-Z0-9(]${WIN_SEG_CHAR}*){0,4}`;

// A single segment: a whitespace-free run plus any continuation tokens.
const WIN_SEG = `${WIN_SEG_CHAR}+${WIN_SEG_CONT}`;

// Quoted form — inside double quotes the path is already delimited, so spaces
// are allowed freely. The quotes are matched by lookaround rather than consumed,
// which keeps the captured value flush with its span.
const WIN_PATH_QUOTED = String.raw`(?<=")[A-Za-z]:\\[^"\r\n]*(?=")`;

// Unquoted form — drive, then backslash-separated segments.
const WIN_PATH_UNQUOTED = String.raw`[A-Za-z]:\\(?:${WIN_SEG}\\)*(?:${WIN_SEG})?`;

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
