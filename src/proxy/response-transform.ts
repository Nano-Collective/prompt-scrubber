import { StringDecoder } from 'node:string_decoder';
import { rehydrateText } from '../core/rehydrate.js';
import { type JsonTextTransform, mapJsonStringField, mapJsonStrings } from './json-scrub.js';
import type { ProxyProvider } from './types.js';

/**
 * Rehydrate placeholders in OpenAI chat-completion responses.
 *
 * Non-streaming: `choices[].message.content` is a string, and a tool-calling
 * turn additionally carries `choices[].message.tool_calls[]` whose
 * `function.arguments` is JSON encoded as a string. The arguments have to be
 * restored too: the client executes that tool locally, so a placeholder left
 * in there reaches the caller's own code instead of the real value.
 *
 * Streaming: each SSE `data:` payload carries a `choices[].delta` object whose
 * `content` field is an incremental string fragment; see
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
    const choice = asRecord(raw);
    if (!choice) return raw;
    const message = asRecord(choice.message);
    if (!message) return raw;

    const patch: Record<string, unknown> = {};

    if (typeof message.content === 'string') {
      const { content, replaced } = rehydrateText(message.content, sessionMap);
      placeholders += replaced;
      if (content !== message.content) patch.content = content;
    }

    const add = (n: number) => {
      placeholders += n;
    };
    const toolCalls = rehydrateToolCallArguments(message.tool_calls, sessionMap, add);
    if (toolCalls !== message.tool_calls) patch.tool_calls = toolCalls;
    // Deprecated single-call form, still accepted by the API.
    const functionCall = rehydrateCallArguments(message.function_call, sessionMap, add);
    if (functionCall !== message.function_call) patch.function_call = functionCall;

    if (Object.keys(patch).length === 0) return raw;
    return { ...choice, message: { ...message, ...patch } };
  });

  return { body: { ...root, choices }, placeholders };
}

/**
 * Rehydrate placeholders in Anthropic `/v1/messages` responses.
 *
 * Non-streaming: `content` is an array of blocks. `text` blocks and the
 * `input` object of a `tool_use` block are restored; other block types
 * (`image`, `thinking`, ...) pass through.
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
  const content = root.content.map((raw) => {
    const block = asRecord(raw);
    if (!block) return raw;

    if (block.type === 'text' && typeof block.text === 'string') {
      const { content: text, replaced } = rehydrateText(block.text, sessionMap);
      placeholders += replaced;
      if (text === block.text) return raw;
      return { ...block, text };
    }

    if (block.type === 'tool_use') {
      const { value, count } = mapJsonStrings(block.input, rehydrateTransform(sessionMap));
      placeholders += count;
      if (value === block.input) return raw;
      return { ...block, input: value };
    }

    return raw;
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

/** Per-response state the SSE rehydrator threads through the event walk. */
interface StreamState {
  provider: ProxyProvider;
  sessionMap: Record<string, string>;
  /** `sessionMap` with its values escaped for a JSON-string context. */
  escaped: () => Record<string, string>;
  /** Fragments held back mid-placeholder, keyed by the call they belong to. */
  tails: Map<string, PendingTail>;
}

interface PendingTail {
  text: string;
  /** Builds a standalone SSE event carrying `text`, for recovery at flush. */
  synthesize: (text: string) => string;
}

/**
 * Incrementally rehydrate an SSE byte stream.
 *
 * Two different splits have to be handled. A *chunk* boundary can fall
 * anywhere, so bytes that do not yet form a complete event (events are
 * separated by a blank line) are buffered, and multibyte codepoints are
 * reassembled by `StringDecoder`.
 *
 * An *event* boundary is the harder one: vendors emit roughly one token per
 * event, so `«Email_1»` genuinely arrives as `«Email_` in one event and `1»`
 * in the next. Leaving it unresolved hands the reader, or for tool-call
 * arguments the client's own tool, a literal placeholder, so a trailing
 * partial placeholder is held back and prepended to the next fragment of that
 * same text or call (see `rehydrateFragment`).
 */
export function createSseRehydrator(
  provider: ProxyProvider,
  sessionMap: Record<string, string>,
): {
  push: (chunk: Buffer | Uint8Array) => string;
  flush: () => string;
} {
  const decoder = new StringDecoder('utf8');
  const state: StreamState = {
    provider,
    sessionMap,
    escaped: createEscapedMapReader(sessionMap),
    tails: new Map(),
  };
  let buffer = '';

  return {
    push(chunk: Buffer | Uint8Array): string {
      buffer += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return emitCompleteEvents(state, buffer, (rest) => {
        buffer = rest;
      });
    },
    flush(): string {
      buffer += decoder.end();
      const tail = emitCompleteEvents(state, `${buffer}\n\n`, (rest) => {
        buffer = rest;
      });
      // A tail still held here means the stream ended mid-placeholder (a
      // truncated or hallucinated `«`). Emitting it as a vendor-shaped delta
      // event of its own is the only way to hand those bytes over without
      // corrupting the framing — dropping them would silently truncate the
      // tool's arguments. It lands after the terminating event, which a
      // client may ignore; losing the bytes outright is worse.
      let orphans = '';
      for (const pending of state.tails.values()) {
        orphans += pending.synthesize(pending.text);
      }
      state.tails.clear();
      // After flushing, anything still in `buffer` is the trailing fragment
      // that never had a terminating blank line. Emit it as-is so the client
      // receives the final bytes (e.g. the `[DONE]` sentinel or a trailing
      // event without a final newline).
      const leftover = buffer;
      buffer = '';
      return tail + orphans + leftover;
    },
  };
}

// A line ends with CRLF, a lone CR or a lone LF (HTML Living Standard, 9.2.6), and a
// blank line, which ends an event, is two terminators in a row. A CR followed by LF is
// one terminator, not two.
const EOL = String.raw`(?:\r\n|\r(?!\n)|\n)`;
const EVENT_BOUNDARY = new RegExp(`${EOL}${EOL}`, 'g');
const LINE_BREAK = /\r\n|\r|\n/;

function emitCompleteEvents(
  state: StreamState,
  input: string,
  setRemainder: (rest: string) => void,
): string {
  // A CR at the very end may be the first half of a CRLF whose LF is in the next
  // chunk, so it waits for more input before it can be read as a terminator.
  const held = input.endsWith('\r') ? '\r' : '';
  const body = held ? input.slice(0, -1) : input;

  // Events are separated by a blank line. Whatever follows the last boundary is
  // kept in the buffer so partial data is never emitted early.
  const events: string[] = [];
  let start = 0;
  for (const boundary of body.matchAll(EVENT_BOUNDARY)) {
    events.push(body.slice(start, boundary.index));
    start = boundary.index + boundary[0].length;
  }
  setRemainder(body.slice(start) + held);

  let out = '';
  for (const event of events) {
    if (event.length === 0) {
      out += '\n\n';
      continue;
    }
    out += transformSseEvent(state, event);
    out += '\n\n';
  }
  return out;
}

/**
 * Transform a single SSE event block. Lines beginning with `data: ` carry the
 * JSON payload. Output lines always end with a bare LF, whatever the upstream used. Everything else (`event:`, `id:`, `:comment`, etc.) is passed
 * through unchanged.
 */
function transformSseEvent(state: StreamState, event: string): string {
  const lines = event.split(LINE_BREAK);
  const out: string[] = [];
  for (const line of lines) {
    if (line.startsWith('data:')) {
      // SSE allows `data:` (no space) and `data: ` (with space). Match both.
      const payload = line.startsWith('data: ') ? line.slice('data: '.length) : line.slice(5);
      out.push(`data: ${transformSseData(state, payload)}`);
    } else {
      out.push(line);
    }
  }
  return out.join('\n');
}

function transformSseData(state: StreamState, payload: string): string {
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
  if (state.provider === 'openai') {
    transformed = rehydrateOpenAIStreamChunk(parsed, state);
  } else if (state.provider === 'anthropic') {
    transformed = rehydrateAnthropicStreamChunk(parsed, state);
  }
  // Skip the round-trip when nothing changed — `JSON.stringify` on an already
  // compact payload would otherwise introduce subtle whitespace differences.
  if (transformed === parsed) return payload;
  return JSON.stringify(transformed);
}

/**
 * OpenAI streaming chunks:
 *   `{ choices: [ { delta: { content: "..." }, index: 0 } ] }`
 *
 * `delta.content` is sometimes `null` (e.g. role-only chunks). A tool call
 * streams instead as `delta.tool_calls[].function.arguments`, one fragment of
 * the JSON argument string per chunk, identified by `tool_calls[].index`.
 */
function rehydrateOpenAIStreamChunk(payload: unknown, state: StreamState): unknown {
  if (typeof payload !== 'object' || payload === null) return payload;
  const root = payload as Record<string, unknown>;
  if (!Array.isArray(root.choices)) return payload;

  let changed = false;
  const choices = root.choices.map((raw) => {
    const choice = asRecord(raw);
    if (!choice) return raw;
    const delta = asRecord(choice.delta);
    if (!delta) return raw;

    const patch: Record<string, unknown> = {};
    const choiceIndex = typeof choice.index === 'number' ? choice.index : 0;

    if (typeof delta.content === 'string') {
      const content = rehydrateFragment(
        delta.content,
        `openai:${choiceIndex}:content`,
        state,
        (text) => synthesizeOpenAIEvent(choiceIndex, { content: text }),
        false,
      );
      if (content !== delta.content) patch.content = content;
    }

    const toolCalls = rehydrateStreamedToolCalls(delta.tool_calls, choiceIndex, state);
    if (toolCalls !== delta.tool_calls) patch.tool_calls = toolCalls;

    if (Object.keys(patch).length === 0) return raw;
    changed = true;
    return { ...choice, delta: { ...delta, ...patch } };
  });

  return changed ? { ...root, choices } : payload;
}

/**
 * Anthropic streaming chunks:
 *   `{ type: "content_block_delta", index: N, delta: { type: "text_delta", text: "..." } }`
 *   `{ type: "content_block_delta", index: N, delta: { type: "input_json_delta", partial_json: "..." } }`
 *
 * Only those two delta shapes are rewritten. Other event types
 * (`message_start`, `content_block_start`, `ping`, etc.) pass through
 * untouched.
 */
function rehydrateAnthropicStreamChunk(payload: unknown, state: StreamState): unknown {
  if (typeof payload !== 'object' || payload === null) return payload;
  const root = payload as Record<string, unknown>;
  if (root.type !== 'content_block_delta') return payload;
  const delta = asRecord(root.delta);
  if (!delta) return payload;

  const index = typeof root.index === 'number' ? root.index : 0;

  if (typeof delta.text === 'string') {
    const text = rehydrateFragment(
      delta.text,
      `anthropic:${index}:text`,
      state,
      (held) => synthesizeAnthropicEvent(index, { type: 'text_delta', text: held }),
      false,
    );
    if (text === delta.text) return payload;
    return { ...root, delta: { ...delta, text } };
  }

  if (typeof delta.partial_json === 'string') {
    const next = rehydrateFragment(delta.partial_json, `anthropic:${index}`, state, (text) =>
      synthesizeAnthropicEvent(index, { type: 'input_json_delta', partial_json: text }),
    );
    if (next === delta.partial_json) return payload;
    return { ...root, delta: { ...delta, partial_json: next } };
  }

  return payload;
}

/**
 * Restore placeholders inside `tool_calls[].function.arguments` /
 * `function_call.arguments` on a non-streaming response: parse, replace,
 * re-stringify, so a restored value containing a quote or a backslash is
 * escaped properly and the field stays valid JSON.
 */
function rehydrateToolCallArguments(
  value: unknown,
  sessionMap: Record<string, string>,
  add: (n: number) => void,
): unknown {
  if (!Array.isArray(value)) return value;

  let changed = false;
  const next = value.map((raw) => {
    const call = asRecord(raw);
    if (!call) return raw;
    const fn = rehydrateCallArguments(call.function, sessionMap, add);
    if (fn === call.function) return raw;
    changed = true;
    return { ...call, function: fn };
  });

  return changed ? next : value;
}

function rehydrateCallArguments(
  value: unknown,
  sessionMap: Record<string, string>,
  add: (n: number) => void,
): unknown {
  const fn = asRecord(value);
  if (!fn || typeof fn.arguments !== 'string') return value;
  const { value: args, count } = mapJsonStringField(
    fn.arguments,
    rehydrateTransform(sessionMap),
    // Malformed `arguments` cannot be re-serialised, so the restored value
    // has to be escaped by hand for the JSON string it still sits in.
    (text) => {
      const { content, replaced } = rehydrateText(text, escapeMapForJsonString(sessionMap));
      return { content, count: replaced };
    },
  );
  add(count);
  if (args === fn.arguments) return value;
  return { ...fn, arguments: args };
}

/** Streaming counterpart: one fragment of an argument string per event. */
function rehydrateStreamedToolCalls(value: unknown, choice: number, state: StreamState): unknown {
  if (!Array.isArray(value)) return value;

  let changed = false;
  const next = value.map((raw) => {
    const call = asRecord(raw);
    if (!call) return raw;
    const fn = asRecord(call.function);
    if (!fn || typeof fn.arguments !== 'string') return raw;

    const index = typeof call.index === 'number' ? call.index : 0;
    const args = rehydrateFragment(fn.arguments, `openai:${choice}:${index}`, state, (text) =>
      synthesizeOpenAIEvent(choice, { tool_calls: [{ index, function: { arguments: text } }] }),
    );
    if (args === fn.arguments) return raw;
    changed = true;
    return { ...call, function: { ...fn, arguments: args } };
  });

  return changed ? next : value;
}

/**
 * Longest tail worth holding back. Placeholders are short (`«Email_1»`), so
 * anything longer is an unrelated guillemet rather than a partial
 * placeholder, and buffering it would stall the stream.
 */
const MAX_HELD_TAIL = 48;

/**
 * Restore placeholders in a streamed *fragment* of a field, which is not
 * complete on its own.
 *
 * Two things make this different from rehydrating a whole field:
 *
 * 1. A placeholder may straddle the boundary between two events. The part
 *    from an unterminated `«` onwards is withheld and prepended to the next
 *    fragment for the same text or call, so the client's reassembled output
 *    carries the real value.
 * 2. A slice of `arguments` / `partial_json` sits inside a JSON string literal
 *    that the client will reassemble, so a substituted value must be escaped
 *    as that literal's contents: `C:\Users\alice` has to land as
 *    `C:\\Users\\alice`. Plain text (`inJsonString` false) is serialised with
 *    the rest of its event, so its values go in unescaped.
 */
function rehydrateFragment(
  fragment: string,
  key: string,
  state: StreamState,
  synthesize: (text: string) => string,
  inJsonString = true,
): string {
  const previous = state.tails.get(key);
  const combined = previous === undefined ? fragment : previous.text + fragment;
  const { ready, held } = splitAtOpenPlaceholder(combined);

  if (held.length > 0) state.tails.set(key, { text: held, synthesize });
  else state.tails.delete(key);

  if (!ready.includes('«')) return ready;
  return rehydrateText(ready, inJsonString ? state.escaped() : state.sessionMap).content;
}

/**
 * Split a fragment into the part safe to emit now and a trailing partial
 * placeholder to hold back.
 */
function splitAtOpenPlaceholder(text: string): { ready: string; held: string } {
  const start = text.lastIndexOf('«');
  if (start === -1) return { ready: text, held: '' };
  // A closing guillemet after it means this one is already complete.
  if (text.includes('»', start)) return { ready: text, held: '' };

  const candidate = text.slice(start);
  // Placeholders carry no whitespace and are short; anything else is ordinary
  // text that happens to contain a `«`.
  if (candidate.length > MAX_HELD_TAIL || /\s/.test(candidate)) {
    return { ready: text, held: '' };
  }
  return { ready: text.slice(0, start), held: candidate };
}

function synthesizeOpenAIEvent(choiceIndex: number, delta: Record<string, unknown>): string {
  const payload = { choices: [{ index: choiceIndex, delta }] };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function synthesizeAnthropicEvent(blockIndex: number, delta: Record<string, unknown>): string {
  const payload = { type: 'content_block_delta', index: blockIndex, delta };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * Build the escaped view of the session map lazily, reusing it until the map
 * grows. The request side mutates the map in place, but only ever *adds*
 * placeholders — a placeholder's value is stable once minted — so the entry
 * count is a sound cache key.
 */
function createEscapedMapReader(sessionMap: Record<string, string>): () => Record<string, string> {
  let cached: Record<string, string> | undefined;
  let size = -1;
  return () => {
    const current = Object.keys(sessionMap).length;
    if (cached === undefined || current !== size) {
      cached = escapeMapForJsonString(sessionMap);
      size = current;
    }
    return cached;
  };
}

function escapeMapForJsonString(sessionMap: Record<string, string>): Record<string, string> {
  const escaped: Record<string, string> = {};
  for (const [placeholder, value] of Object.entries(sessionMap)) {
    // `JSON.stringify` of a string yields a quoted literal; drop the quotes
    // to get exactly the escaped body we need to splice in.
    escaped[placeholder] = JSON.stringify(value).slice(1, -1);
  }
  return escaped;
}

/** Adapt `rehydrateText` to the shape `json-scrub` expects. */
function rehydrateTransform(sessionMap: Record<string, string>): JsonTextTransform {
  return (text) => {
    const { content, replaced } = rehydrateText(text, sessionMap);
    return { content, count: replaced };
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
