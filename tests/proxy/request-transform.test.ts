import test from 'ava';
import {
  detectProvider,
  scrubAnthropicMessagesBody,
  scrubChatBody,
  scrubOpenAIChatBody,
} from '../../src/proxy/request-transform.js';

test('detectProvider recognises OpenAI chat completions paths', (t) => {
  t.is(detectProvider('/v1/chat/completions'), 'openai');
  t.is(detectProvider('/v1/chat/completions/'), 'openai');
  t.is(detectProvider('/openai/v1/chat/completions'), 'openai');
  t.is(detectProvider('/v1/models'), 'unknown');
});

test('detectProvider recognises Anthropic messages paths', (t) => {
  t.is(detectProvider('/v1/messages'), 'anthropic');
  t.is(detectProvider('/v1/messages/'), 'anthropic');
  t.is(detectProvider('/anthropic/v1/messages'), 'anthropic');
});

test('detectProvider returns unknown for unrelated paths', (t) => {
  t.is(detectProvider('/'), 'unknown');
  t.is(detectProvider('/health'), 'unknown');
  t.is(detectProvider('/v1/embeddings'), 'unknown');
  t.is(detectProvider(''), 'unknown');
});

test('scrubOpenAIChatBody scrubs string content fields', (t) => {
  const body = {
    model: 'gpt-4',
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Email me at alice@example.com' },
    ],
  };
  const seen: string[] = [];
  const result = scrubOpenAIChatBody(body, (text) => {
    seen.push(text);
    const replaced = text.includes('alice@example.com') ? 1 : 0;
    return {
      content: replaced ? text.replace('alice@example.com', '«Email_1»') : text,
      entities: replaced,
    };
  });
  t.deepEqual(seen, ['You are helpful.', 'Email me at alice@example.com']);
  t.is(result.entities, 1);
  const out = result.body as { messages: Array<{ content: string }> };
  t.is(out.messages[0]?.content, 'You are helpful.');
  t.is(out.messages[1]?.content, 'Email me at «Email_1»');
});

test('scrubOpenAIChatBody scrubs only text parts in array content', (t) => {
  const body = {
    model: 'gpt-4',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Reach me at bob@example.com' },
          { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } },
        ],
      },
    ],
  };
  const result = scrubOpenAIChatBody(body, (text) => ({
    content: text.replace('bob@example.com', '«Email_1»'),
    entities: 1,
  }));
  t.is(result.entities, 1);
  const out = result.body as {
    messages: Array<{ content: Array<{ type: string; text?: string }> }>;
  };
  const parts = out.messages[0]?.content;
  t.is(parts?.[0]?.text, 'Reach me at «Email_1»');
  // image_url part is untouched (and still preserves its data)
  t.deepEqual(parts?.[1], { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } });
});

test('scrubOpenAIChatBody returns the body untouched when shape does not match', (t) => {
  const body = { unrelated: true };
  const result = scrubOpenAIChatBody(body, () => ({ content: '', entities: 0 }));
  t.is(result.body, body);
  t.is(result.entities, 0);
});

test('scrubOpenAIChatBody returns the body untouched when messages is missing', (t) => {
  const body = { model: 'gpt-4' };
  const result = scrubOpenAIChatBody(body, () => ({ content: '', entities: 0 }));
  t.is(result.body, body);
  t.is(result.entities, 0);
});

test('scrubAnthropicMessagesBody scrubs string content', (t) => {
  const body = {
    model: 'claude-3',
    messages: [{ role: 'user', content: 'Path is /Users/alice/projects' }],
  };
  const result = scrubAnthropicMessagesBody(body, (text) => ({
    content: text.replace('/Users/alice/projects', '«Path_1»'),
    entities: 1,
  }));
  t.is(result.entities, 1);
  const out = result.body as { messages: Array<{ content: string }> };
  t.is(out.messages[0]?.content, 'Path is «Path_1»');
});

test('scrubAnthropicMessagesBody scrubs text blocks but not images', (t) => {
  const body = {
    model: 'claude-3',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Look at carol@example.com and this:' },
          { type: 'image', source: { type: 'base64', data: '...' } },
        ],
      },
    ],
  };
  const result = scrubAnthropicMessagesBody(body, (text) => ({
    content: text.replace('carol@example.com', '«Email_1»'),
    entities: 1,
  }));
  t.is(result.entities, 1);
  const out = result.body as {
    messages: Array<{ content: Array<{ type: string; text?: string; source?: unknown }> }>;
  };
  const parts = out.messages[0]?.content;
  t.is(parts?.[0]?.text, 'Look at «Email_1» and this:');
  t.deepEqual(parts?.[1]?.source, { type: 'base64', data: '...' });
});

test('scrubChatBody dispatches by provider', (t) => {
  t.is(scrubChatBody('unknown', { foo: 1 }, () => ({ content: '', entities: 0 })).entities, 0);
  // openai and anthropic branch behavior covered above; here we just verify
  // that 'unknown' returns the same reference.
  const body = { foo: 1 };
  const result = scrubChatBody('unknown', body, () => ({ content: '', entities: 0 }));
  t.is(result.body, body);
});
