import type { RehydrateRequest, RehydrateResult } from '../types/index.js';
import { readSessionMap } from '../session/storage.js';

const PLACEHOLDER_REGEX = /\b([A-Za-z]+_\d+)\b/g;

/**
 * Restores original values from placeholders in the given content string,
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
  const { content, sessionId } = request;
  const sessionMap = readSessionMap(sessionId);

  // Collect all unique placeholder tokens found in the content
  const foundTokens = new Set<string>();
  let match: RegExpExecArray | null;
  PLACEHOLDER_REGEX.lastIndex = 0;
  while ((match = PLACEHOLDER_REGEX.exec(content)) !== null) {
    foundTokens.add(match[1]!);
  }

  if (foundTokens.size === 0) {
    return { content };
  }

  // Sort by length DESC to prevent shorter placeholders clobbering longer ones
  const sortedTokens = [...foundTokens].sort((a, b) => b.length - a.length);

  let result = content;
  const warnings: string[] = [];

  for (const token of sortedTokens) {
    if (token in sessionMap) {
      // Replace all occurrences of this exact placeholder
      result = result.split(token).join(sessionMap[token]!);
    } else {
      warnings.push(
        `Warning: placeholder ${token} not found in session — left as-is.`,
      );
    }
  }

  return warnings.length > 0 ? { content: result, warnings } : { content: result };
}
