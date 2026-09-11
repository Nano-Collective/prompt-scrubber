import { readSessionMap } from '../session/storage.js';
import type { RehydrateRequest, RehydrateResult } from '../types/index.js';

// Free-form, whitespace-excluding prefix, matching what scrub actually mints:
// `placeholderPrefix` is a public extension point, so a rule pack using
// `Ticket2` produces «Ticket2_1». Restricting to [A-Za-z]+ here left every
// such placeholder unrehydratable — scrubbed away, then never restored.
// Whitespace stays excluded so ordinary quoted text ending in `_<digits>`
// (e.g. French/Russian guillemets) is never misread as a placeholder.
const PLACEHOLDER_REGEX = /«([^«»\s]+_\d+)»/g;

function rehydrateString(
  content: string,
  sessionMap: Record<string, string>,
): { content: string; warnings: string[] } {
  // Collect all unique placeholder tokens found in the content
  const foundTokens = new Set<string>();
  let match: RegExpExecArray | null;
  PLACEHOLDER_REGEX.lastIndex = 0;
  while ((match = PLACEHOLDER_REGEX.exec(content)) !== null) {
    foundTokens.add(match[1]!);
  }

  if (foundTokens.size === 0) {
    return { content, warnings: [] };
  }

  // Sort by length DESC to prevent shorter placeholders clobbering longer ones
  const sortedTokens = [...foundTokens].sort((a, b) => b.length - a.length);

  let result = content;
  const warnings: string[] = [];

  for (const token of sortedTokens) {
    const fullToken = `«${token}»`;
    if (fullToken in sessionMap) {
      // Replace all occurrences of this exact placeholder
      result = result.split(fullToken).join(sessionMap[fullToken]!);
    } else {
      warnings.push(`Warning: placeholder ${fullToken} not found in session — left as-is.`);
    }
  }

  return { content: result, warnings };
}

/**
 * Lightweight rehydrate that only returns the rewritten text and the number
 * of placeholder occurrences replaced. Used by the streaming proxy to avoid
 * pulling in the full `RehydrateResult` shape (with `warnings`) on every
 * SSE chunk.
 *
 * Hallucinated placeholders are silently left in place; that's acceptable
 * for the proxy because the upstream never echoes a placeholder it didn't
 * see in its own request.
 */
export function rehydrateText(
  content: string,
  sessionMap: Record<string, string>,
): { content: string; replaced: number } {
  const foundTokens = new Set<string>();
  const re = new RegExp(PLACEHOLDER_REGEX.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    foundTokens.add(match[1]!);
  }

  if (foundTokens.size === 0) {
    return { content, replaced: 0 };
  }

  const sortedTokens = [...foundTokens].sort((a, b) => b.length - a.length);
  let result = content;
  let replaced = 0;
  for (const token of sortedTokens) {
    const fullToken = `«${token}»`;
    const value = sessionMap[fullToken];
    if (typeof value !== 'string') continue;
    const countRe = new RegExp(PLACEHOLDER_REGEX.source, 'g');
    while ((match = countRe.exec(result)) !== null) {
      if (match[0] === fullToken) replaced += 1;
    }
    result = result.split(fullToken).join(value);
  }
  return { content: result, replaced };
}

/**
 * Restores original values from placeholders in the given content,
 * using the session map identified by sessionId.
 *
 * - Known placeholders are replaced with their originalValue.
 * - Unknown placeholders (hallucinated by the LLM) are left as-is and a
 *   warning is added to the result.
 *
 * Placeholders are replaced longest-first to prevent partial replacements
 * (e.g. Email_10 being corrupted to Email_1<remaining-0>).
 */
export function rehydrate(request: RehydrateRequest): RehydrateResult {
  const { content, sessionId, sessionMap: reqSessionMap } = request;
  const sessionMap = reqSessionMap || (sessionId ? readSessionMap(sessionId) : {});

  if (typeof content === 'string') {
    const { content: result, warnings } = rehydrateString(content, sessionMap);
    return warnings.length > 0 ? { content: result, warnings } : { content: result };
  } else {
    // Array of messages
    const warnings: string[] = [];
    const result = content.map((msg) => {
      const { content: rehydratedStr, warnings: msgWarnings } = rehydrateString(
        msg.content,
        sessionMap,
      );
      warnings.push(...msgWarnings);
      return { ...msg, content: rehydratedStr };
    });

    return warnings.length > 0 ? { content: result, warnings } : { content: result };
  }
}
