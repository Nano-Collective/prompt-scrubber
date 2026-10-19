/**
 * Helpers for rewriting the string leaves of a JSON value.
 *
 * Tool-calling requests hide text in two shapes the plain `messages[].content`
 * walk cannot reach: an object the vendor nests inside the body
 * (Anthropic's `tool_use.input`) and, worse, JSON *encoded as a string*
 * (OpenAI's `tool_calls[].function.arguments`).
 *
 * Both directions (scrub on the way out, rehydrate on the way back) share
 * these helpers so their escaping rules cannot drift apart. That matters most
 * on the return trip: a restored value may itself contain a backslash or a
 * quote (`C:\Users\alice`), and splicing it into a JSON string by hand would
 * emit `"C:\Users\alice"` — not valid JSON. Going through `JSON.stringify`
 * escapes it correctly.
 */

/**
 * Rewrite one string. `count` is the number of replacements made, which the
 * callers aggregate into their `entities` / `placeholders` totals.
 */
export type JsonTextTransform = (text: string) => { content: string; count: number };

/**
 * Depth cap for the recursive walk. Request bodies come from the network, so
 * a pathological nesting depth must not blow the stack. Real tool arguments
 * are a handful of levels deep at most.
 *
 * Past the cap the subtree is returned *unchanged*, so a value nested deeper
 * than this is forwarded unscrubbed. Failing open rather than dropping the
 * subtree is deliberate — see `MAX_DEPTH` in `request-transform.ts`.
 */
const MAX_DEPTH = 64;

/**
 * Rewrite every string leaf of a parsed JSON value.
 *
 * Object *keys* are never touched — a renamed key changes the contract the
 * model is answering, and keys are structure, not content. Numbers, booleans
 * and `null` are returned as they are.
 *
 * The original reference is returned when nothing changed, so callers can
 * skip re-serialising an untouched body.
 */
export function mapJsonStrings(
  value: unknown,
  fn: JsonTextTransform,
  depth = 0,
): { value: unknown; count: number } {
  if (depth > MAX_DEPTH) return { value, count: 0 };

  if (typeof value === 'string') {
    const { content, count } = fn(value);
    return { value: content, count };
  }

  if (Array.isArray(value)) {
    let count = 0;
    let changed = false;
    const next = value.map((item) => {
      const result = mapJsonStrings(item, fn, depth + 1);
      count += result.count;
      if (result.value !== item) changed = true;
      return result.value;
    });
    return changed ? { value: next, count } : { value, count };
  }

  if (typeof value === 'object' && value !== null) {
    let count = 0;
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const result = mapJsonStrings(item, fn, depth + 1);
      count += result.count;
      if (result.value !== item) changed = true;
      next[key] = result.value;
    }
    return changed ? { value: next, count } : { value, count };
  }

  return { value, count: 0 };
}

/**
 * Rewrite a field that carries JSON *as a string* — OpenAI's
 * `tool_calls[].function.arguments`.
 *
 * Parse, rewrite the leaves, re-stringify. That keeps keys and structure
 * intact and guarantees the field is still valid JSON afterwards.
 *
 * A string that does not parse is handed to `onUnparseable` whole (`fn` by
 * default): a half-written or hand-rolled argument blob — smaller models emit
 * them regularly — is still text on its way to the model, so it is better
 * scrubbed as prose than forwarded in the clear.
 *
 * The rehydrate direction must override `onUnparseable`: without a parse there
 * is no `JSON.stringify` to escape with, and splicing a restored `C:\Users\…`
 * into what is still a JSON string literal would leave the client holding
 * invalid escapes. It passes a transform that escapes for that context.
 */
export function mapJsonStringField(
  raw: string,
  fn: JsonTextTransform,
  onUnparseable: JsonTextTransform = fn,
): { value: string; count: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const { content, count } = onUnparseable(raw);
    return { value: content, count };
  }

  const { value, count } = mapJsonStrings(parsed, fn);
  if (count === 0) return { value: raw, count: 0 };
  return { value: JSON.stringify(value), count };
}
