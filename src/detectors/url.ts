import type { Detector, Finding } from '../types/index.js';

// Full HTTP/HTTPS URLs, including paths, query strings, and fragments.
const FULL_URL_REGEX = /https?:\/\/(?:[a-zA-Z0-9\-._~:/?#[\]@!$&'()*+,;=%]+)/g;

// Bare API endpoint pattern: hostname/path (no scheme).
// Requires: a dot in the hostname (rejects bare words) + at least one path segment.
const BARE_API_REGEX =
  /(?<![/\w])([a-zA-Z0-9][a-zA-Z0-9-]*\.[a-zA-Z]{2,}(?:\.[a-zA-Z]{2,})?\/[a-zA-Z0-9\-._~:/?#[\]@!$&'()*+,;=%]+)/g;

export class UrlDetector implements Detector {
  readonly name = 'UrlDetector';

  constructor(private allowlist: string[] = []) {}

  private isHostAllowed(urlStr: string): boolean {
    if (this.allowlist.length === 0) return false;
    try {
      const parsed = new URL(urlStr.startsWith('http') ? urlStr : `http://${urlStr}`);
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
      const value = match[0];
      if (this.isHostAllowed(value)) continue;

      raw.push({
        category: 'Url',
        span: [match.index, match.index + value.length],
        value,
        placeholderPrefix: 'Url',
      });
    }

    BARE_API_REGEX.lastIndex = 0;
    while ((match = BARE_API_REGEX.exec(text)) !== null) {
      const value = match[1] ?? match[0];
      const start = match.index + (match[0].length - value.length);
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
        });
      }
    }

    return raw.sort((a, b) => a.span[0] - b.span[0]);
  }
}
