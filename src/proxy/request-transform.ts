import { isCredentialKeyName } from '../detectors/secret.js';
import { placeholderTokensIn } from '../session/session-manager.js';
import { type JsonTextTransform, mapJsonStringField, mapJsonStrings } from './json-scrub.js';
import type { ProxyProvider } from './types.js';

/**
 * Path patterns we recognise as chat-completion endpoints. Matches are
 * anchored to the URL pathname so `/v1/models` does not accidentally look
 * like a chat request. The `*` segments are intentionally permissive: most
 * vendors expose `/v1/chat/completions`, but Anthropic uses `/v1/messages`
 * and a few gateways use `/openai/v1/chat/completions` and similar.
 */
const OPENAI_CHAT_RE = /(^|\/)v1\/chat\/completions\/?$/;
const ANTHROPIC_MESSAGES_RE = /(^|\/)v1\/messages\/?$/;

export function detectProvider(pathname: string): ProxyProvider {
  if (OPENAI_CHAT_RE.test(pathname)) return 'openai';
  if (ANTHROPIC_MESSAGES_RE.test(pathname)) return 'anthropic';
  return 'unknown';
}

export interface ScrubOutcome {
  /** Scrubbed body. May be the same reference when nothing matched. */
  body: unknown;
  /** Number of replacements made in this pass. */
  entities: number;
}

/**
 * Scrub one string. Mirrors the signature `scrub()` is wrapped into. `asSecret` says the
 * whole string is a secret, whatever it looks like, and is redacted as one.
 */
type ScrubFn = (content: string, asSecret?: boolean) => { content: string; entities: number };

/** Sink for the running replacement count. */
type Accumulate = (n: number) => void;

/** Scrubs one entry of a `content` array. Shaped per provider. */
type PartScrubber = (part: unknown, scrub: ScrubFn, add: Accumulate, depth: number) => unknown;

/**
 * Depth cap for the recursive walks: nested `tool_result` blocks and tool
 * schemas. Bodies arrive from the network and `JSON.parse` accepts far deeper
 * nesting than a recursive walk of it survives, so without a cap a ~70 KB
 * request can exhaust the stack.
 *
 * Past the cap a subtree is forwarded *unscrubbed* rather than dropped.
 * Failing open is deliberate: deleting part of a request breaks working
 * clients, and nothing legitimate nests tool results or schema descriptions
 * 64 deep — anything that does is adversarial, and the proxy is a development
 * tool on a trusted host (see the threat model).
 */
const MAX_DEPTH = 64;

/**
 * Scrub an OpenAI-shaped chat-completion request.
 *
 * Covered: `messages[].content` (string or `text` parts),
 * `messages[].tool_calls[].function.arguments` (JSON encoded as a string),
 * the free-text `description` fields of `tools[]`, the end-user identifiers
 * `user`, `safety_identifier` and `metadata`, `prediction.content`, and the
 * descriptions inside `response_format.json_schema`. The deprecated
 * function-calling fields (`messages[].function_call.arguments` and the
 * top-level `functions[]`) are covered too — the API still accepts them, so
 * a client on an older SDK or Azure api-version needs the same protection.
 *
 * Deliberately untouched: tool names, tool-call ids, JSON-schema property
 * keys and `enum` values. Those are the contract the model has to echo back
 * verbatim, so a placeholder there would break the caller's dispatch rather
 * than protect anything.
 *
 * The function is total: it returns `body` untouched when the shape does not
 * match, when the body is not an object, or when there is nothing to scrub.
 */
export function scrubOpenAIChatBody(body: unknown, scrub: ScrubFn): ScrubOutcome {
  return scrubBody(body, scrub, {
    part: scrubOpenAIContentPart,
    message: scrubOpenAIMessage,
    schemaKey: 'parameters',
    tools: scrubOpenAIToolDefinitions,
    legacyTools: 'functions',
    requestFields: scrubOpenAIRequestFields,
  });
}

/**
 * Scrub an Anthropic `/v1/messages` request.
 *
 * Covered: the top-level `system` prompt (string or `text` blocks),
 * `messages[].content` (string, `text` blocks, `tool_result` blocks and
 * `tool_use.input` objects, `document` and `search_result` blocks), the
 * free-text `description` fields of `tools[]`, and `metadata`.
 *
 * Deliberately untouched: tool names, `tool_use`/`tool_result` ids, and
 * `input_schema` property keys and `enum` values - see
 * `scrubOpenAIChatBody` for why.
 */
export function scrubAnthropicMessagesBody(body: unknown, scrub: ScrubFn): ScrubOutcome {
  return scrubBody(body, scrub, {
    part: scrubAnthropicContentPart,
    message: scrubAnthropicMessage,
    schemaKey: 'input_schema',
    tools: scrubFlatToolDefinitions,
    system: true,
    requestFields: scrubAnthropicRequestFields,
  });
}

/**
 * Dispatch to the appropriate scrubber based on detected provider. Returns
 * the body untouched when the provider is `unknown` so the caller can
 * substitute and forward without conditionals.
 */
export function scrubChatBody(
  provider: ProxyProvider,
  body: unknown,
  scrub: ScrubFn,
): ScrubOutcome {
  if (provider === 'openai') return scrubOpenAIChatBody(body, scrub);
  if (provider === 'anthropic') return scrubAnthropicMessagesBody(body, scrub);
  return { body, entities: 0 };
}

interface ProviderShape {
  /** Scrubs one entry of a message's `content` array. */
  part: PartScrubber;
  /** Scrubs one entry of `messages[]`. */
  message: (msg: unknown, scrub: ScrubFn, add: Accumulate, shape: ProviderShape) => unknown;
  /** Where this vendor keeps a tool's JSON schema. */
  schemaKey: string;
  /** Scrubs `tools[]`. */
  tools: (value: unknown, scrub: ScrubFn, add: Accumulate, shape: ProviderShape) => unknown;
  /** Whether this vendor carries a top-level `system` prompt. */
  system?: boolean;
  /**
   * Body key of a deprecated sibling of `tools[]` holding flat
   * `{name, description, <schemaKey>}` entries — OpenAI's `functions[]`.
   */
  legacyTools?: string;
  /** Scrubs the vendor's remaining request-level fields. Returns the keys to replace. */
  requestFields: (
    root: Record<string, unknown>,
    scrub: ScrubFn,
    add: Accumulate,
    shape: ProviderShape,
  ) => Record<string, unknown>;
}

/**
 * Walk the fields of a request body that can carry text. The two providers
 * differ only in which block types they nest and where they keep the tool
 * schema, so the traversal itself is shared.
 */
function scrubBody(body: unknown, scrub: ScrubFn, shape: ProviderShape): ScrubOutcome {
  const root = asRecord(body);
  if (!root) return { body, entities: 0 };

  let entities = 0;
  const add: Accumulate = (n) => {
    entities += n;
  };
  const patch: Record<string, unknown> = {};

  // `messages` is walked, never filtered. A message with no `content` key at
  // all (an assistant turn that only carries `tool_calls`) used to be dropped
  // from the forwarded body, which left the upstream looking at a tool result
  // for a call it never saw.
  if (Array.isArray(root.messages)) {
    const next = mapPreservingIdentity(root.messages, (msg) =>
      shape.message(msg, scrub, add, shape),
    );
    if (next !== root.messages) patch.messages = next;
  }

  if (shape.system === true) {
    const system = scrubContent(root.system, scrub, add, shape.part);
    if (system !== root.system) patch.system = system;
  }

  const tools = shape.tools(root.tools, scrub, add, shape);
  if (tools !== root.tools) patch.tools = tools;

  if (shape.legacyTools !== undefined) {
    const key = shape.legacyTools;
    const legacy = scrubFlatToolDefinitions(root[key], scrub, add, shape);
    if (legacy !== root[key]) patch[key] = legacy;
  }

  Object.assign(patch, shape.requestFields(root, scrub, add, shape));

  if (Object.keys(patch).length === 0) return { body, entities };
  return { body: { ...root, ...patch }, entities };
}

/**
 * Scrub a `content` field, which every vendor allows to be either a plain
 * string or an array of typed parts. Anything else (`null`, an omitted
 * field, a number) is returned untouched.
 */
function scrubContent(
  content: unknown,
  scrub: ScrubFn,
  add: Accumulate,
  part: PartScrubber,
  depth = 0,
): unknown {
  if (typeof content === 'string') return scrubText(content, scrub, add);
  if (Array.isArray(content)) {
    return mapPreservingIdentity(content, (entry) => part(entry, scrub, add, depth));
  }
  return content;
}

function scrubOpenAIRequestFields(
  root: Record<string, unknown>,
  scrub: ScrubFn,
  add: Accumulate,
  shape: ProviderShape,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};

  for (const key of ['user', 'safety_identifier']) {
    const next = scrubText(root[key], scrub, add);
    if (next !== root[key]) patch[key] = next;
  }

  const metadata = scrubStringValues(root.metadata, scrub, add);
  if (metadata !== root.metadata) patch.metadata = metadata;

  const prediction = asRecord(root.prediction);
  if (prediction) {
    const content = scrubContent(prediction.content, scrub, add, shape.part);
    if (content !== prediction.content) patch.prediction = { ...prediction, content };
  }

  const format = asRecord(root.response_format);
  const jsonSchema = asRecord(format?.json_schema);
  if (format && jsonSchema) {
    const next = scrubToolDescriptions(jsonSchema, scrub, add, 'schema');
    if (next !== jsonSchema) patch.response_format = { ...format, json_schema: next };
  }

  return patch;
}

function scrubAnthropicRequestFields(
  root: Record<string, unknown>,
  scrub: ScrubFn,
  add: Accumulate,
): Record<string, unknown> {
  const metadata = scrubStringValues(root.metadata, scrub, add);
  return metadata === root.metadata ? {} : { metadata };
}

/** Scrub every string leaf of a JSON value, leaving keys and structure alone. */
function scrubStringValues(value: unknown, scrub: ScrubFn, add: Accumulate): unknown {
  const { value: next, count } = mapJsonStrings(value, asJsonTransform(scrub));
  add(count);
  return next;
}

function scrubOpenAIMessage(
  msg: unknown,
  scrub: ScrubFn,
  add: Accumulate,
  shape: ProviderShape,
): unknown {
  const record = asRecord(msg);
  if (!record) return msg;

  const patch: Record<string, unknown> = {};

  const content = scrubContent(record.content, scrub, add, shape.part);
  if (content !== record.content) patch.content = content;

  const toolCalls = scrubOpenAIToolCalls(record.tool_calls, scrub, add);
  if (toolCalls !== record.tool_calls) patch.tool_calls = toolCalls;

  // Deprecated single-call form, still accepted by the API.
  const functionCall = scrubCallArguments(record.function_call, scrub, add);
  if (functionCall !== record.function_call) patch.function_call = functionCall;

  if (Object.keys(patch).length === 0) return msg;
  return { ...record, ...patch };
}

function scrubAnthropicMessage(
  msg: unknown,
  scrub: ScrubFn,
  add: Accumulate,
  shape: ProviderShape,
): unknown {
  const record = asRecord(msg);
  if (!record) return msg;

  const content = scrubContent(record.content, scrub, add, shape.part);
  if (content === record.content) return msg;
  return { ...record, content };
}

/**
 * OpenAI content parts: `{type:"text", text:"..."}` alongside binary-ish
 * parts (`image_url`, `input_audio`, `file`) which pass through unchanged.
 */
function scrubOpenAIContentPart(part: unknown, scrub: ScrubFn, add: Accumulate): unknown {
  // No nested-content block type here, so no depth to track.
  const record = asRecord(part);
  if (!record) return part;
  if (record.type === 'text' && typeof record.text === 'string') {
    const text = scrubText(record.text, scrub, add);
    if (text === record.text) return part;
    return { ...record, text };
  }
  return part;
}

/**
 * Anthropic content blocks. `text` blocks carry prose; `tool_result` nests
 * the tool's own output (usually the richest PII in a conversation) one level
 * further down; `tool_use` carries the arguments as a real object. `document`
 * and `search_result` blocks carry text the client supplies for the model to
 * read. Everything else (`image`, `thinking`, ...) passes through unchanged:
 * `thinking` is model output and holds placeholders, not the real values.
 */
function scrubAnthropicContentPart(
  part: unknown,
  scrub: ScrubFn,
  add: Accumulate,
  depth = 0,
): unknown {
  const record = asRecord(part);
  if (!record) return part;
  // `tool_result` blocks nest, so this walk is bounded like the schema walk.
  if (depth > MAX_DEPTH) return part;

  if (record.type === 'text' && typeof record.text === 'string') {
    const text = scrubText(record.text, scrub, add);
    if (text === record.text) return part;
    return { ...record, text };
  }

  if (record.type === 'tool_result') {
    // A tool result's `content` follows the same string-or-parts rule as a
    // message's, so recurse through this very function.
    const content = scrubContent(record.content, scrub, add, scrubAnthropicContentPart, depth + 1);
    if (content === record.content) return part;
    return { ...record, content };
  }

  if (record.type === 'tool_use') {
    const { value, count } = mapJsonStrings(record.input, asJsonTransform(scrub));
    add(count);
    if (value === record.input) return part;
    return { ...record, input: value };
  }

  if (record.type === 'document') return scrubAnthropicDocument(record, scrub, add, depth);

  if (record.type === 'search_result') {
    const patch: Record<string, unknown> = {};
    const title = scrubText(record.title, scrub, add);
    if (title !== record.title) patch.title = title;
    const content = scrubContent(record.content, scrub, add, scrubAnthropicContentPart, depth + 1);
    if (content !== record.content) patch.content = content;
    return Object.keys(patch).length === 0 ? part : { ...record, ...patch };
  }

  return part;
}

/**
 * A `document` block: the `title` and `context` strings, plus the text of a
 * `text` source or the nested blocks of a `content` source. `base64` and `url`
 * sources are opaque and pass through.
 */
function scrubAnthropicDocument(
  record: Record<string, unknown>,
  scrub: ScrubFn,
  add: Accumulate,
  depth: number,
): unknown {
  const patch: Record<string, unknown> = {};

  for (const key of ['title', 'context']) {
    const next = scrubText(record[key], scrub, add);
    if (next !== record[key]) patch[key] = next;
  }

  const source = asRecord(record.source);
  if (source?.type === 'text') {
    const data = scrubText(source.data, scrub, add);
    if (data !== source.data) patch.source = { ...source, data };
  } else if (source?.type === 'content') {
    const content = scrubContent(source.content, scrub, add, scrubAnthropicContentPart, depth + 1);
    if (content !== source.content) patch.source = { ...source, content };
  }

  return Object.keys(patch).length === 0 ? record : { ...record, ...patch };
}

/**
 * `tool_calls[].function.arguments` is JSON encoded as a *string*, so it is
 * parsed, scrubbed leaf by leaf and re-stringified: argument keys and the
 * function name stay exactly as the client sent them.
 */
function scrubOpenAIToolCalls(value: unknown, scrub: ScrubFn, add: Accumulate): unknown {
  if (!Array.isArray(value)) return value;
  return mapPreservingIdentity(value, (call) => {
    const record = asRecord(call);
    if (!record) return call;
    const fn = scrubCallArguments(record.function, scrub, add);
    if (fn === record.function) return call;
    return { ...record, function: fn };
  });
}

/**
 * Scrub the `arguments` of one `{name, arguments}` call object — the shape
 * shared by `tool_calls[].function` and the deprecated `function_call`.
 */
function scrubCallArguments(value: unknown, scrub: ScrubFn, add: Accumulate): unknown {
  const fn = asRecord(value);
  if (!fn || typeof fn.arguments !== 'string') return value;
  const { value: args, count } = mapJsonStringField(fn.arguments, asJsonTransform(scrub));
  add(count);
  if (args === fn.arguments) return value;
  return { ...fn, arguments: args };
}

/**
 * OpenAI tool definitions, which wrap the describable part in a sub-object
 * named after the tool type: `{type:"function", function:{…}}` and the newer
 * `{type:"custom", custom:{…}}`.
 */
function scrubOpenAIToolDefinitions(
  value: unknown,
  scrub: ScrubFn,
  add: Accumulate,
  shape: ProviderShape,
): unknown {
  if (!Array.isArray(value)) return value;
  return mapPreservingIdentity(value, (tool) => {
    const record = asRecord(tool);
    if (!record) return tool;
    const patch: Record<string, unknown> = {};
    for (const key of ['function', 'custom'] as const) {
      const inner = asRecord(record[key]);
      if (!inner) continue;
      const next = scrubToolDescriptions(inner, scrub, add, shape.schemaKey);
      if (next !== inner) patch[key] = next;
    }
    if (Object.keys(patch).length === 0) return tool;
    return { ...record, ...patch };
  });
}

/**
 * Tool definitions that carry `{name, description, <schema>}` flat on the
 * entry: every Anthropic tool, and OpenAI's deprecated `functions[]`.
 */
function scrubFlatToolDefinitions(
  value: unknown,
  scrub: ScrubFn,
  add: Accumulate,
  shape: ProviderShape,
): unknown {
  if (!Array.isArray(value)) return value;
  return mapPreservingIdentity(value, (tool) => {
    const record = asRecord(tool);
    if (!record) return tool;
    const next = scrubToolDescriptions(record, scrub, add, shape.schemaKey);
    return next === record ? tool : next;
  });
}

/**
 * Scrub a tool's own `description` plus every `description` nested in its
 * JSON schema. Both are prose written by the developer, and both routinely
 * carry internal hostnames, paths and example records.
 */
function scrubToolDescriptions(
  record: Record<string, unknown>,
  scrub: ScrubFn,
  add: Accumulate,
  schemaKey: string,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};

  const description = scrubText(record.description, scrub, add);
  if (description !== record.description) patch.description = description;

  const schema = scrubSchemaDescriptions(record[schemaKey], scrub, add);
  if (schema !== record[schemaKey]) patch[schemaKey] = schema;

  if (Object.keys(patch).length === 0) return record;
  return { ...record, ...patch };
}

/**
 * Walk a JSON schema and scrub only the values of `description` keys.
 *
 * Property names, `type`, `required` and `enum` values are structure: the
 * model must reproduce them exactly for the caller's dispatch to work, so
 * they are left alone even when they look like PII.
 */
function scrubSchemaDescriptions(
  value: unknown,
  scrub: ScrubFn,
  add: Accumulate,
  depth = 0,
): unknown {
  if (depth > MAX_DEPTH) return value;

  if (Array.isArray(value)) {
    return mapPreservingIdentity(value, (item) =>
      scrubSchemaDescriptions(item, scrub, add, depth + 1),
    );
  }

  const record = asRecord(value);
  if (!record) return value;

  const patch: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    const next =
      key === 'description' && typeof item === 'string'
        ? scrubText(item, scrub, add)
        : scrubSchemaDescriptions(item, scrub, add, depth + 1);
    if (next !== item) patch[key] = next;
  }

  if (Object.keys(patch).length === 0) return value;
  return { ...record, ...patch };
}

function scrubText(value: unknown, scrub: ScrubFn, add: Accumulate): unknown {
  if (typeof value !== 'string') return value;
  const { content, entities } = scrub(value);
  add(entities);
  return content;
}

/**
 * Adapt the proxy's scrub callback to the shape `json-scrub` expects. A string under a key
 * that names a credential (`"password": "..."`), however many objects or arrays lie between
 * (`"password": {"value": "..."}`), is a secret whatever it looks like, so it is redacted
 * whole. A value that is already one placeholder is left to the plain scrub, which keeps the
 * token it holds; a value that only contains one is still a secret.
 */
function asJsonTransform(scrub: ScrubFn): JsonTextTransform {
  return (text, keys = []) => {
    const asSecret = keys.some(isCredentialKeyName) && placeholderTokensIn(text)[0] !== text;
    const { content, entities } = asSecret ? scrub(text, true) : scrub(text);
    return { content, count: entities };
  };
}

/**
 * `Array.prototype.map`, but the original array is returned when every entry
 * came back identical. Keeping the reference lets each caller tell "nothing
 * matched here" from "this field was rewritten" with a `!==` check.
 */
function mapPreservingIdentity<T>(items: T[], fn: (item: T) => unknown): unknown[] | T[] {
  let changed = false;
  const next = items.map((item) => {
    const result = fn(item);
    if (result !== item) changed = true;
    return result;
  });
  return changed ? next : items;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
