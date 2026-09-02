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
  /** Body with `messages[].content` scrubbed. May be the same reference. */
  body: unknown;
  /** Number of replacements made in this pass. */
  entities: number;
}

type ContentPart = { type?: unknown; text?: unknown; [k: string]: unknown };

interface ChatMessage {
  role: string;
  content: string | ContentPart[];
  [k: string]: unknown;
}

/**
 * Scrub `messages[].content` for OpenAI-shaped chat-completion requests.
 *
 * OpenAI accepts both a string content and an array of content parts
 * (`{type:"text", text:"..."}` and `{type:"image_url", ...}`). Only text
 * fields are scrubbed; image parts pass through unchanged.
 *
 * The function is total: it returns `body` untouched when the shape does
 * not match, when the body is not an object, or when there is nothing to
 * scrub.
 */
export function scrubOpenAIChatBody(
  body: unknown,
  scrub: (content: string) => { content: string; entities: number },
): ScrubOutcome {
  const messages = getMessages(body);
  if (!messages) return { body, entities: 0 };

  let entities = 0;
  const next: ChatMessage[] = messages.map((msg) => {
    if (typeof msg.content === 'string') {
      const { content, entities: added } = scrub(msg.content);
      entities += added;
      return { ...msg, content };
    }
    if (Array.isArray(msg.content)) {
      const parts = msg.content.map((part) =>
        scrubContentPart(part, scrub, (n) => (entities += n)),
      );
      return { ...msg, content: parts };
    }
    return msg;
  });

  return { body: { ...(body as Record<string, unknown>), messages: next }, entities };
}

/**
 * Scrub `messages[].content` for Anthropic `/v1/messages` requests.
 *
 * Anthropic accepts both a string content and an array of content blocks
 * (`{type:"text", text:"..."}`, `{type:"image", ...}`, etc.). Only `text`
 * blocks are scrubbed.
 */
export function scrubAnthropicMessagesBody(
  body: unknown,
  scrub: (content: string) => { content: string; entities: number },
): ScrubOutcome {
  const messages = getMessages(body);
  if (!messages) return { body, entities: 0 };

  let entities = 0;
  const next: ChatMessage[] = messages.map((msg) => {
    if (typeof msg.content === 'string') {
      const { content, entities: added } = scrub(msg.content);
      entities += added;
      return { ...msg, content };
    }
    if (Array.isArray(msg.content)) {
      const parts = msg.content.map((part) =>
        scrubContentPart(part, scrub, (n) => (entities += n)),
      );
      return { ...msg, content: parts };
    }
    return msg;
  });

  return { body: { ...(body as Record<string, unknown>), messages: next }, entities };
}

/**
 * Dispatch to the appropriate scrubber based on detected provider. Returns
 * the body untouched when the provider is `unknown` so the caller can
 * substitute and forward without conditionals.
 */
export function scrubChatBody(
  provider: ProxyProvider,
  body: unknown,
  scrub: (content: string) => { content: string; entities: number },
): ScrubOutcome {
  if (provider === 'openai') return scrubOpenAIChatBody(body, scrub);
  if (provider === 'anthropic') return scrubAnthropicMessagesBody(body, scrub);
  return { body, entities: 0 };
}

function getMessages(body: unknown): ChatMessage[] | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const root = body as Record<string, unknown>;
  if (!Array.isArray(root.messages)) return undefined;
  return root.messages.filter(isChatMessage);
}

function isChatMessage(value: unknown): value is ChatMessage {
  return typeof value === 'object' && value !== null && 'content' in value;
}

function scrubContentPart(
  part: unknown,
  scrub: (content: string) => { content: string; entities: number },
  accumulate: (n: number) => void,
): ContentPart {
  if (typeof part !== 'object' || part === null) return part as ContentPart;
  const obj = part as ContentPart;
  if (obj.type === 'text' && typeof obj.text === 'string') {
    const { content, entities } = scrub(obj.text);
    accumulate(entities);
    return { ...obj, text: content };
  }
  return obj;
}
