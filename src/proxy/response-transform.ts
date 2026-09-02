import { StringDecoder } from 'node:string_decoder';
import type { ProxyProvider } from './types.js';

/**
 * Rehydrate placeholders in OpenAI chat-completion responses.
 *
 * Non-streaming: `choices[].message.content` is a string.
 * Streaming: each SSE `data:` payload carries a `choices[].delta` object whose
 * `content` field is an incremental string fragment; replacing placeholders
 * across the whole fragment would corrupt output (`«Email_1»` arrives as
 * `«Email_` then `1»`), so the streaming path is handled separately in
 * `createSseRehydrator`.
 */
export function rehydrateOpenAIJsonBody(
  body: unknown,
  sessionMap: Record<string, string>,
): { body: unknown; placeholders: number } {
  if (typeof body !== 'object' || body === null) return { body, placeholders: 0 };
  const root = body as Record<string, unknown>;
  if (!Array.isArray(root.choices)) return { body, placeholders: 0 };

  let placeholders = 0;
  const choices = root.choices.map((raw) => {
    if (typeof raw !== 'object' || raw === null) return raw;
    const choice = raw as Record<string, unknown>;
    if (typeof choice.message === 'object' && choice.message !== null) {
      const message = choice.message as Record<string, unknown>;
      if (typeof message.content === 'string') {
        const { content, replaced } = rehydrateString(message.content, sessionMap);
        placeholders += replaced;
        return { ...choice, message: { ...message, content } };
      }
    }
    return choice;
  });

  return { body: { ...root, choices }, placeholders };
}

/**
 * Rehydrate placeholders in Anthropic `/v1/messages` responses.
 *
 * Non-streaming: `content` is an array of blocks. Only `text` blocks are
 * touched; other block types (`tool_use`, `image`, ...) pass through.
 */
export function rehydrateAnthropicJsonBody(
  body: unknown,
  sessionMap: Record<string, string>,
): { body: unknown; placeholders: number } {
  if (typeof body !== 'object' || body === null) return { body, placeholders: 0 };
  const root = body as Record<string, unknown>;
  if (typeof root.content !== 'object' || root.content === null) {
    return { body, placeholders: 0 };
  }
  if (!Array.isArray(root.content)) return { body, placeholders: 0 };

  let placeholders = 0;
  const content = root.content.map((block) => {
    if (
      typeof block === 'object' &&
      block !== null &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
    ) {
      const { content: text, replaced } = rehydrateString(
        (block as { text: string }).text,
        sessionMap,
      );
      placeholders += replaced;
      return { ...block, text };
    }
    return block;
  });

  return { body: { ...root, content }, placeholders };
}

export function rehydrateJsonBody(
  provider: ProxyProvider,
  body: unknown,
  sessionMap: Record<string, string>,
): { body: unknown; placeholders: number } {
  if (provider === 'openai') return rehydrateOpenAIJsonBody(body, sessionMap);
  if (provider === 'anthropic') return rehydrateAnthropicJsonBody(body, sessionMap);
  return { body, placeholders: 0 };
}

/**
 * Count how many placeholder occurrences were replaced. Used for the
 * `rehydrated` proxy event.
 */
function rehydrateString(
  text: string,
  sessionMap: Record<string, string>,
): { content: string; replaced: number } {
  const sortedTokens = Object.keys(sessionMap).sort((a, b) => b.length - a.length);
  if (sortedTokens.length === 0) return { content: text, replaced: 0 };

  let result = text;
  let replaced = 0;
  for (const token of sortedTokens) {
    const value = sessionMap[token];
    if (typeof value !== 'string') continue;
    // Count non-overlapping occurrences of `token` in `result`.
    let searchFrom = 0;
    while (true) {
      const idx = result.indexOf(token, searchFrom);
      if (idx === -1) break;
      replaced += 1;
      searchFrom = idx + token.length;
    }
    result = result.split(token).join(value);
  }
  return { content: result, replaced };
}

/**
 * Incrementally rehydrate an SSE byte stream.
 *
 * Placeholders like `«Email_1»` may be split across chunks (`«Email_` then
 * `1»`). To handle that we buffer trailing bytes that don't yet form a
 * complete SSE event. SSE events are separated by a blank line (`\n\n`); we
 * keep the incomplete tail and emit only complete events downstream.
 *
 * Multibyte UTF-8 codepoints may also be split across chunks; the
 * `StringDecoder` handles that so we never see replacement errors.
 */
export function createSseRehydrator(
  provider: ProxyProvider,
  sessionMap: Record<string, string>,
): {
  push: (chunk: Buffer | Uint8Array) => string;
  flush: () => string;
} {
  const decoder = new StringDecoder('utf8');
  let buffer = '';

  return {
    push(chunk: Buffer | Uint8Array): string {
      buffer += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return emitCompleteEvents(provider, sessionMap, buffer, (rest) => {
        buffer = rest;
      });
    },
    flush(): string {
      buffer += decoder.end();
      const tail = emitCompleteEvents(provider, sessionMap, `${buffer}\n\n`, (rest) => {
        buffer = rest;
      });
      // After flushing, anything still in `buffer` is the trailing fragment
      // that never had a terminating blank line. Emit it as-is so the client
      // receives the final bytes (e.g. the `[DONE]` sentinel or a trailing
      // event without a final newline).
      const leftover = buffer;
      buffer = '';
      return tail + leftover;
    },
  };
}

function emitCompleteEvents(
  provider: ProxyProvider,
  sessionMap: Record<string, string>,
  input: string,
  setRemainder: (rest: string) => void,
): string {
  // SSE events are separated by a blank line. The split produces an empty
  // element at the end when the input already ends with `\n\n`, which we want
  // to keep in `buffer` so we don't prematurely emit partial data.
  const events = input.split('\n\n');
  const remainder = events.pop() ?? '';
  setRemainder(remainder);

  let out = '';
  for (const event of events) {
    if (event.length === 0) {
      out += '\n\n';
      continue;
    }
    out += transformSseEvent(provider, sessionMap, event);
    out += '\n\n';
  }
  return out;
}

/**
 * Transform a single SSE event block. Lines beginning with `data: ` carry the
 * JSON payload. Everything else (`event:`, `id:`, `:comment`, etc.) is passed
 * through unchanged.
 */
function transformSseEvent(
  provider: ProxyProvider,
  sessionMap: Record<string, string>,
  event: string,
): string {
  const lines = event.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    if (line.startsWith('data:')) {
      // SSE allows `data:` (no space) and `data: ` (with space). Match both.
      const payload = line.startsWith('data: ') ? line.slice('data: '.length) : line.slice(5);
      out.push(`data: ${transformSseData(provider, sessionMap, payload)}`);
    } else {
      out.push(line);
    }
  }
  return out.join('\n');
}

function transformSseData(
  provider: ProxyProvider,
  sessionMap: Record<string, string>,
  payload: string,
): string {
  const trimmed = payload.trim();
  if (trimmed === '[DONE]' || trimmed === '') return payload;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Not JSON — pass through untouched. We never want to corrupt binary or
    // non-JSON SSE payloads (e.g. custom event types some vendors emit).
    return payload;
  }

  let transformed: unknown = parsed;
  if (provider === 'openai') {
    transformed = rehydrateOpenAIStreamChunk(parsed, sessionMap);
  } else if (provider === 'anthropic') {
    transformed = rehydrateAnthropicStreamChunk(parsed, sessionMap);
  }
  // `JSON.stringify` on the already-JSON payload preserves the wire shape
  // while letting us rewrite text fields. The original payload may have been
  // pretty-printed, but SSE bodies are conventionally compact, so this is
  // indistinguishable from the upstream bytes in practice.
  return JSON.stringify(transformed);
}

/**
 * OpenAI streaming chunks:
 *   `{ choices: [ { delta: { content: "..." }, index: 0 } ] }`
 *
 * `delta.content` is sometimes `null` (e.g. role-only chunks).
 */
function rehydrateOpenAIStreamChunk(payload: unknown, sessionMap: Record<string, string>): unknown {
  if (typeof payload !== 'object' || payload === null) return payload;
  const root = payload as Record<string, unknown>;
  if (!Array.isArray(root.choices)) return payload;
  const choices = root.choices.map((raw) => {
    if (typeof raw !== 'object' || raw === null) return raw;
    const choice = raw as Record<string, unknown>;
    if (typeof choice.delta !== 'object' || choice.delta === null) return choice;
    const delta = choice.delta as Record<string, unknown>;
    if (typeof delta.content === 'string') {
      const { content, replaced } = rehydrateString(delta.content, sessionMap);
      if (replaced === 0) return choice;
      return { ...choice, delta: { ...delta, content } };
    }
    return choice;
  });
  return { ...root, choices };
}

/**
 * Anthropic streaming chunks:
 *   `{ type: "content_block_delta", index: N, delta: { type: "text_delta", text: "..." } }`
 *
 * Only `content_block_delta` events with a string `text` field are scrubbed.
 * Other event types (`message_start`, `content_block_start`, `ping`, etc.)
 * pass through untouched.
 */
function rehydrateAnthropicStreamChunk(
  payload: unknown,
  sessionMap: Record<string, string>,
): unknown {
  if (typeof payload !== 'object' || payload === null) return payload;
  const root = payload as Record<string, unknown>;
  if (root.type !== 'content_block_delta') return payload;
  if (typeof root.delta !== 'object' || root.delta === null) return payload;
  const delta = root.delta as Record<string, unknown>;
  if (typeof delta.text !== 'string') return payload;
  const { content: text } = rehydrateString(delta.text, sessionMap);
  return { ...root, delta: { ...delta, text } };
}
