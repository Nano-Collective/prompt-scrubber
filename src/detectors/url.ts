import type { Detector, Finding } from '../types/index.js';

// The characters a URL can run through, shared with the secret detector so it can tell
// whether a key sits inside a URL this detector will redact.
export const URL_CHARS = String.raw`[a-zA-Z0-9\-._~:/?#[\]@!$&'()*+,;=%]`;

// Full HTTP/HTTPS URLs, including paths, query strings, and fragments.
const FULL_URL_REGEX = new RegExp(`https?://${URL_CHARS}+`, 'g');

// Bare API endpoint pattern: hostname/path (no scheme).
// Requires: a dot in the hostname (rejects bare words) + at least one path segment.
// `(?<!\w-)` keeps a match from starting inside a hyphenated run, which would
// rescan the rest of the run from every hyphen.
const BARE_API_REGEX =
  /(?<![/\w])(?<!\w-)([a-zA-Z0-9][a-zA-Z0-9-]*\.[a-zA-Z]{2,}(?:\.[a-zA-Z]{2,})?\/[a-zA-Z0-9\-._~:/?#[\]@!$&'()*+,;=%]+)/g;

// A scheme makes the match unambiguous; a bare host/path has to guess from a
// dot and a slash, which also describes plenty of file paths and prose.
const FULL_URL_CONFIDENCE = 0.95;
const BARE_URL_CONFIDENCE = 0.7;

// Only marks that are almost never the real end of a URL. `!`, `;`, `'` and
// `*` are valid URL characters, and trimming them would leave the last
// character of a query value unredacted.
const TRAILING_PUNCTUATION = new Set(['.', ',', ':', '?']);

function trimTrailingUrlPunctuation(url: string): string {
  let trimmed = url;
  while (trimmed.length > 0) {
    const lastChar = trimmed[trimmed.length - 1]!;
    if (TRAILING_PUNCTUATION.has(lastChar)) {
      trimmed = trimmed.slice(0, -1);
      continue;
    }
    if (lastChar === ')') {
      const openCount = (trimmed.match(/\(/g) ?? []).length;
      const closeCount = (trimmed.match(/\)/g) ?? []).length;
      if (closeCount > openCount) {
        trimmed = trimmed.slice(0, -1);
        continue;
      }
    }
    if (lastChar === ']') {
      const openCount = (trimmed.match(/\[/g) ?? []).length;
      const closeCount = (trimmed.match(/\]/g) ?? []).length;
      if (closeCount > openCount) {
        trimmed = trimmed.slice(0, -1);
        continue;
      }
    }
    break;
  }
  return trimmed;
}

function isValidFullUrl(url: string): boolean {
  if (!url.startsWith('http://') && !url.startsWith('https://')) return false;
  const rest = url.replace(/^https?:\/\//, '');
  return rest.length > 0 && !rest.startsWith('/');
}

function isValidBareApi(url: string): boolean {
  const slashIndex = url.indexOf('/');
  if (slashIndex <= 0) return false;
  const host = url.slice(0, slashIndex);
  return host.includes('.');
}

// Query or fragment parameters whose name says the value is a credential. An
// allowlisted host does not make `?api_key=...` safe to forward.
const SECRET_PARAM_WORDS = new Set([
  'key',
  'apikey',
  'token',
  'secret',
  'password',
  'passwd',
  'pwd',
  'auth',
  'sig',
  'signature',
  'credential',
  'credentials',
  'session',
  'sessionid',
  'jwt',
  'bearer',
]);

function hasSecretParam(url: string): boolean {
  // The first `?` or `#` begins the query or fragment: neither is legal unescaped in the
  // scheme, user info, host or path that come before it. The scheme may be absent (a
  // bare `host/path`), which changes nothing here.
  const start = url.search(/[?#]/);
  if (start === -1) return false;
  return url
    .slice(start + 1)
    .split(/[&;#?]/)
    .some((pair) => {
      if (!pair.includes('=')) return false;
      const name = (pair.split('=')[0] ?? '').replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
      return name.split(/[_.-]/).some((word) => SECRET_PARAM_WORDS.has(word));
    });
}

export class UrlDetector implements Detector {
  readonly name = 'UrlDetector';

  constructor(private allowlist: string[] = []) {}

  private isHostAllowed(urlStr: string): boolean {
    if (this.allowlist.length === 0) return false;
    try {
      const parsed = new URL(urlStr.startsWith('http') ? urlStr : `http://${urlStr}`);
      if (parsed.username || parsed.password || hasSecretParam(urlStr)) return false;
      const host = parsed.hostname;
      return this.allowlist.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
    } catch {
      return false;
    }
  }

  detect(text: string): Finding[] {
    const raw: Finding[] = [];

    FULL_URL_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = FULL_URL_REGEX.exec(text)) !== null) {
      const originalValue = match[0];
      const value = trimTrailingUrlPunctuation(originalValue);
      if (!isValidFullUrl(value)) continue;
      if (this.isHostAllowed(value)) continue;

      raw.push({
        category: 'Url',
        span: [match.index, match.index + value.length],
        value,
        placeholderPrefix: 'Url',
        confidence: FULL_URL_CONFIDENCE,
        method: 'exact-pattern',
      });
    }

    BARE_API_REGEX.lastIndex = 0;
    while ((match = BARE_API_REGEX.exec(text)) !== null) {
      const originalValue = match[1] ?? match[0];
      const start = match.index + (match[0].length - originalValue.length);
      const value = trimTrailingUrlPunctuation(originalValue);
      if (!isValidBareApi(value)) continue;

      // Skip if already covered by a full URL match
      const alreadyCovered = raw.some(
        (existing) => start >= existing.span[0] && start < existing.span[1],
      );
      if (!alreadyCovered && !this.isHostAllowed(value)) {
        raw.push({
          category: 'Url',
          span: [start, start + value.length],
          value,
          placeholderPrefix: 'Url',
          confidence: BARE_URL_CONFIDENCE,
          method: 'heuristic',
        });
      }
    }

    return raw.sort((a, b) => a.span[0] - b.span[0]);
  }
}
