import test from 'ava';
import { scrub } from '../../src/core/scrub.js';
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

/**
 * Stand-in for the real scrubber: replaces the two e-mail addresses used in
 * these tests with stable placeholders and counts the replacements.
 */
function fakeScrub(text: string): { content: string; entities: number } {
  let content = text;
  let entities = 0;
  for (const [needle, placeholder] of [
    ['john@example.com', '«Email_1»'],
    ['alice@example.com', '«Email_2»'],
  ] as const) {
    const parts = content.split(needle);
    entities += parts.length - 1;
    content = parts.join(placeholder);
  }
  return { content, entities };
}

test('scrubOpenAIChatBody keeps a tool-calling assistant message and scrubs its arguments', (t) => {
  // The exact repro from issue #163: the assistant turn carries `tool_calls`
  // and no `content` key at all.
  const body = {
    model: 'gpt-4o',
    messages: [
      { role: 'user', content: 'What is the status of john@example.com?' },
      {
        role: 'assistant',
        tool_calls: [
          {
            id: '1',
            type: 'function',
            function: { name: 'lookup', arguments: '{"email":"john@example.com"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: '1', content: 'User john@example.com has balance $500' },
    ],
  };

  const result = scrubOpenAIChatBody(body, fakeScrub);
  const out = result.body as {
    messages: Array<{
      role: string;
      content?: string;
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
    }>;
  };

  t.is(out.messages.length, 3, 'the assistant message must survive');
  t.is(out.messages[1]?.role, 'assistant');
  t.is(out.messages[0]?.content, 'What is the status of «Email_1»?');
  t.is(out.messages[2]?.content, 'User «Email_1» has balance $500');

  const call = out.messages[1]?.tool_calls?.[0];
  t.is(call?.id, '1');
  t.is(call?.function.name, 'lookup', 'the function name is a contract, never scrubbed');
  t.deepEqual(JSON.parse(call?.function.arguments ?? '{}'), { email: '«Email_1»' });
  t.is(result.entities, 3);
  t.false(JSON.stringify(result.body).includes('john@example.com'));
});

test('scrubOpenAIChatBody keeps an assistant message with content: null', (t) => {
  const body = {
    messages: [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: '1',
            type: 'function',
            function: { name: 'f', arguments: '{"to":"alice@example.com"}' },
          },
        ],
      },
    ],
  };
  const result = scrubOpenAIChatBody(body, fakeScrub);
  const out = result.body as {
    messages: Array<{ content: null; tool_calls: Array<{ function: { arguments: string } }> }>;
  };
  t.is(out.messages.length, 1);
  t.is(out.messages[0]?.content, null, 'a null content stays null');
  t.is(out.messages[0]?.tool_calls[0]?.function.arguments, '{"to":"«Email_2»"}');
  t.is(result.entities, 1);
});

test('scrubOpenAIChatBody preserves entries of messages[] it does not understand', (t) => {
  const body = { messages: [null, 'not a message', 42, { role: 'user', content: 'hi' }] };
  const result = scrubOpenAIChatBody(body, fakeScrub);
  const out = result.body as { messages: unknown[] };
  t.is(out.messages.length, 4);
  t.is(out.messages[0], null);
  t.is(out.messages[1], 'not a message');
  t.is(out.messages[2], 42);
});

test('scrubOpenAIChatBody scrubs tool-call arguments that are not valid JSON as plain text', (t) => {
  const body = {
    messages: [
      {
        role: 'assistant',
        tool_calls: [
          {
            id: '1',
            type: 'function',
            function: { name: 'f', arguments: 'email=john@example.com' },
          },
        ],
      },
    ],
  };
  const result = scrubOpenAIChatBody(body, fakeScrub);
  const out = result.body as {
    messages: Array<{ tool_calls: Array<{ function: { arguments: string } }> }>;
  };
  t.is(out.messages[0]?.tool_calls[0]?.function.arguments, 'email=«Email_1»');
  t.is(result.entities, 1);
});

test('scrubOpenAIChatBody scrubs tool descriptions but not names or enum values', (t) => {
  const body = {
    messages: [{ role: 'user', content: 'hi' }],
    tools: [
      {
        type: 'function',
        function: {
          name: 'notify_john@example.com',
          description: 'Email john@example.com about an order',
          parameters: {
            type: 'object',
            properties: {
              to: {
                type: 'string',
                description: 'Defaults to john@example.com',
                enum: ['john@example.com', 'alice@example.com'],
              },
            },
          },
        },
      },
    ],
  };
  const result = scrubOpenAIChatBody(body, fakeScrub);
  const out = result.body as {
    tools: Array<{
      function: {
        name: string;
        description: string;
        parameters: { properties: { to: { description: string; enum: string[] } } };
      };
    }>;
  };
  const fn = out.tools[0]?.function;
  t.is(fn?.description, 'Email «Email_1» about an order');
  t.is(fn?.parameters.properties.to.description, 'Defaults to «Email_1»');
  t.is(fn?.name, 'notify_john@example.com', 'tool names must round-trip verbatim');
  t.deepEqual(fn?.parameters.properties.to.enum, ['john@example.com', 'alice@example.com']);
  t.is(result.entities, 2);
});

test('scrubAnthropicMessagesBody scrubs a string system prompt', (t) => {
  const body = {
    model: 'claude-3',
    system: 'You support john@example.com.',
    messages: [{ role: 'user', content: 'hi' }],
  };
  const result = scrubAnthropicMessagesBody(body, fakeScrub);
  const out = result.body as { system: string };
  t.is(out.system, 'You support «Email_1».');
  t.is(result.entities, 1);
});

test('scrubAnthropicMessagesBody scrubs system prompt text blocks', (t) => {
  const body = {
    system: [
      { type: 'text', text: 'Contact: john@example.com' },
      { type: 'text', text: 'Backup: alice@example.com', cache_control: { type: 'ephemeral' } },
    ],
    messages: [],
  };
  const result = scrubAnthropicMessagesBody(body, fakeScrub);
  const out = result.body as { system: Array<{ text: string; cache_control?: unknown }> };
  t.is(out.system[0]?.text, 'Contact: «Email_1»');
  t.is(out.system[1]?.text, 'Backup: «Email_2»');
  t.deepEqual(out.system[1]?.cache_control, { type: 'ephemeral' }, 'sibling fields survive');
  t.is(result.entities, 2);
});

test('scrubAnthropicMessagesBody scrubs tool_use input and tool_result content', (t) => {
  const body = {
    messages: [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'lookup',
            input: { email: 'john@example.com', nested: { note: 'cc alice@example.com' } },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            content: 'User john@example.com has balance $500',
          },
        ],
      },
    ],
  };
  const result = scrubAnthropicMessagesBody(body, fakeScrub);
  const out = result.body as {
    messages: Array<{
      content: Array<{
        type: string;
        id?: string;
        name?: string;
        input?: { email: string; nested: { note: string } };
        content?: string;
      }>;
    }>;
  };
  const use = out.messages[0]?.content[0];
  t.is(use?.input?.email, '«Email_1»');
  t.is(use?.input?.nested.note, 'cc «Email_2»');
  t.is(use?.name, 'lookup', 'tool names must round-trip verbatim');
  t.is(use?.id, 'toolu_1');
  t.is(out.messages[1]?.content[0]?.content, 'User «Email_1» has balance $500');
  t.is(result.entities, 3);
});

test('scrubAnthropicMessagesBody scrubs text blocks nested in a tool_result', (t) => {
  const body = {
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            content: [
              { type: 'text', text: 'Owner: john@example.com' },
              { type: 'image', source: { type: 'base64', data: '...' } },
            ],
          },
        ],
      },
    ],
  };
  const result = scrubAnthropicMessagesBody(body, fakeScrub);
  const out = result.body as {
    messages: Array<{ content: Array<{ content: Array<{ text?: string; source?: unknown }> }> }>;
  };
  const inner = out.messages[0]?.content[0]?.content;
  t.is(inner?.[0]?.text, 'Owner: «Email_1»');
  t.deepEqual(inner?.[1]?.source, { type: 'base64', data: '...' });
  t.is(result.entities, 1);
});

test('scrubAnthropicMessagesBody scrubs tool descriptions', (t) => {
  const body = {
    messages: [],
    tools: [
      {
        name: 'lookup',
        description: 'Look up john@example.com',
        input_schema: {
          type: 'object',
          properties: { email: { type: 'string', description: 'e.g. alice@example.com' } },
        },
      },
    ],
  };
  const result = scrubAnthropicMessagesBody(body, fakeScrub);
  const out = result.body as {
    tools: Array<{
      name: string;
      description: string;
      input_schema: { properties: { email: { description: string } } };
    }>;
  };
  t.is(out.tools[0]?.description, 'Look up «Email_1»');
  t.is(out.tools[0]?.input_schema.properties.email.description, 'e.g. «Email_2»');
  t.is(out.tools[0]?.name, 'lookup');
  t.is(result.entities, 2);
});

test('scrubOpenAIChatBody scrubs the deprecated function_call and functions[]', (t) => {
  const body = {
    messages: [
      {
        role: 'assistant',
        function_call: { name: 'lookup', arguments: '{"email":"john@example.com"}' },
      },
    ],
    functions: [
      {
        name: 'lookup',
        description: 'Look up john@example.com',
        parameters: {
          type: 'object',
          properties: { email: { type: 'string', description: 'e.g. alice@example.com' } },
        },
      },
    ],
  };
  const result = scrubOpenAIChatBody(body, fakeScrub);
  const out = result.body as {
    messages: Array<{ function_call: { name: string; arguments: string } }>;
    functions: Array<{
      name: string;
      description: string;
      parameters: { properties: { email: { description: string } } };
    }>;
  };
  t.is(out.messages[0]?.function_call.arguments, '{"email":"«Email_1»"}');
  t.is(out.messages[0]?.function_call.name, 'lookup');
  t.is(out.functions[0]?.description, 'Look up «Email_1»');
  t.is(out.functions[0]?.parameters.properties.email.description, 'e.g. «Email_2»');
  t.is(result.entities, 3);
  t.false(JSON.stringify(result.body).includes('john@example.com'));
});

test('scrubOpenAIChatBody scrubs the description of a custom tool', (t) => {
  const body = {
    messages: [],
    tools: [{ type: 'custom', custom: { name: 'grep', description: 'search john@example.com' } }],
  };
  const result = scrubOpenAIChatBody(body, fakeScrub);
  const out = result.body as { tools: Array<{ custom: { name: string; description: string } }> };
  t.is(out.tools[0]?.custom.description, 'search «Email_1»');
  t.is(out.tools[0]?.custom.name, 'grep');
});

test('scrubAnthropicMessagesBody survives pathologically nested tool_result blocks', (t) => {
  // `JSON.parse` accepts far deeper nesting than a recursive walk survives,
  // so the walk is capped rather than left to exhaust the stack.
  let block: unknown = { type: 'text', text: 'john@example.com' };
  for (let i = 0; i < 5000; i += 1) {
    block = { type: 'tool_result', tool_use_id: 't', content: [block] };
  }
  const body = { messages: [{ role: 'user', content: [block] }] };
  t.notThrows(() => scrubAnthropicMessagesBody(body, fakeScrub));
});

test('scrubAnthropicMessagesBody still scrubs normally nested tool_result blocks', (t) => {
  const body = {
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 't2',
                content: [{ type: 'text', text: 'Owner: john@example.com' }],
              },
            ],
          },
        ],
      },
    ],
  };
  const result = scrubAnthropicMessagesBody(body, fakeScrub);
  t.is(result.entities, 1);
  t.false(JSON.stringify(result.body).includes('john@example.com'));
});

const mark = (text: string) => ({
  content: text.replace('bob@example.com', '«Email_1»'),
  entities: text.includes('bob@example.com') ? 1 : 0,
});

test('scrubOpenAIChatBody scrubs user, metadata, prediction and response_format descriptions', (t) => {
  const E = 'bob@example.com';
  const result = scrubOpenAIChatBody(
    {
      model: 'gpt-4',
      user: E,
      safety_identifier: E,
      metadata: { owner: E, ticket: '42' },
      prediction: { type: 'content', content: `draft for ${E}` },
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'reply',
          description: `sent to ${E}`,
          schema: { type: 'object', properties: { to: { type: 'string', description: E } } },
        },
      },
      messages: [{ role: 'user', content: 'hi' }],
    },
    mark,
  );
  t.is(result.entities, 6);
  const out = result.body as Record<string, any>;
  t.is(out.user, '«Email_1»');
  t.is(out.safety_identifier, '«Email_1»');
  t.deepEqual(out.metadata, { owner: '«Email_1»', ticket: '42' });
  t.is(out.prediction.content, 'draft for «Email_1»');
  t.is(out.response_format.json_schema.description, 'sent to «Email_1»');
  t.is(out.response_format.json_schema.schema.properties.to.description, '«Email_1»');
  t.is(out.response_format.json_schema.name, 'reply');
});

test('scrubOpenAIChatBody leaves a body without those fields untouched', (t) => {
  const body = { model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] };
  const result = scrubOpenAIChatBody(body, mark);
  t.is(result.body, body);
  t.is(result.entities, 0);
});

test('scrubAnthropicMessagesBody scrubs document and search_result blocks and metadata', (t) => {
  const E = 'bob@example.com';
  const result = scrubAnthropicMessagesBody(
    {
      model: 'claude',
      metadata: { user_id: E },
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              title: E,
              context: E,
              source: { type: 'text', media_type: 'text/plain', data: `mail ${E}` },
            },
            { type: 'document', source: { type: 'content', content: [{ type: 'text', text: E }] } },
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: E },
            },
            {
              type: 'search_result',
              source: 'https://a.example',
              title: E,
              content: [{ type: 'text', text: E }],
            },
            {
              type: 'tool_result',
              tool_use_id: '1',
              content: [
                { type: 'document', source: { type: 'text', media_type: 'text/plain', data: E } },
              ],
            },
          ],
        },
      ],
    },
    mark,
  );
  const out = result.body as { metadata: any; messages: [{ content: any[] }] };
  const [doc, nested, opaque, search, toolResult] = out.messages[0].content;
  t.is(out.metadata.user_id, '«Email_1»');
  t.is(doc.title, '«Email_1»');
  t.is(doc.context, '«Email_1»');
  t.is(doc.source.data, 'mail «Email_1»');
  t.is(nested.source.content[0].text, '«Email_1»');
  t.is(opaque.source.data, E);
  t.is(search.title, '«Email_1»');
  t.is(search.content[0].text, '«Email_1»');
  t.is(toolResult.content[0].source.data, '«Email_1»');
  t.is(result.entities, 8);
});

test('scrubAnthropicMessagesBody leaves thinking blocks alone, they hold placeholders already', (t) => {
  const body = {
    model: 'claude',
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'bob@example.com', signature: 's' }],
      },
    ],
  };
  t.is(scrubAnthropicMessagesBody(body, mark).body, body);
});

/** The real scrubber, shaped like the callback the proxy hands the transforms. */
function realScrub(sessionMap = {}) {
  return (text: string) => {
    const result = scrub({ content: text, sessionMap });
    return { content: result.scrubbedContent as string, entities: result.stats.totalEntities };
  };
}

const PASSWORD = 'Zq8Cs3cr3tPwx9Y2!kLmN';

test('scrubs a secret under a secret-looking key in OpenAI tool-call arguments', (t) => {
  const call = (args: unknown) => ({
    role: 'assistant',
    tool_calls: [{ id: '1', type: 'function', function: { name: 'login', arguments: args } }],
  });
  const result = scrubOpenAIChatBody(
    {
      model: 'gpt-4',
      messages: [
        call(JSON.stringify({ username: 'bob', password: PASSWORD })),
        call(JSON.stringify({ config: { api_key: PASSWORD }, tokens: [PASSWORD, `${PASSWORD}2`] })),
        {
          role: 'assistant',
          function_call: { name: 'x', arguments: `{"client_secret":"${PASSWORD}"}` },
        },
      ],
      metadata: { auth_token: PASSWORD, ticket: 'ticket-12345678' },
    },
    realScrub(),
  );
  const out = result.body as {
    messages: Array<{
      tool_calls?: Array<{ function: { arguments: string } }>;
      function_call?: { arguments: string };
    }>;
    metadata: unknown;
  };
  t.is(
    out.messages[0]?.tool_calls?.[0]?.function.arguments,
    '{"username":"bob","password":"«Secret_1»"}',
  );
  t.is(
    out.messages[1]?.tool_calls?.[0]?.function.arguments,
    '{"config":{"api_key":"«Secret_1»"},"tokens":["«Secret_1»","«Secret_2»"]}',
  );
  t.is(out.messages[2]?.function_call?.arguments, '{"client_secret":"«Secret_1»"}');
  t.deepEqual(out.metadata, { auth_token: '«Secret_1»', ticket: 'ticket-12345678' });
  t.is(result.entities, 6);
  t.false(JSON.stringify(result.body).includes(PASSWORD.slice(0, 12)));
});

test('scrubs a secret under a secret-looking key in Anthropic tool input and metadata', (t) => {
  const result = scrubAnthropicMessagesBody(
    {
      model: 'claude',
      max_tokens: 5,
      metadata: { user_id: 'u-1', api_key: PASSWORD },
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 't1',
              name: 'login',
              input: { user: 'bob', password: PASSWORD },
            },
          ],
        },
      ],
    },
    realScrub(),
  );
  const out = result.body as {
    metadata: unknown;
    messages: Array<{ content: Array<{ input: unknown }> }>;
  };
  t.deepEqual(out.messages[0]?.content[0]?.input, { user: 'bob', password: '«Secret_1»' });
  t.deepEqual(out.metadata, { user_id: 'u-1', api_key: '«Secret_1»' });
  t.is(result.entities, 2);
});

test('a secret under a key and the same secret in free text get one placeholder', (t) => {
  const result = scrubOpenAIChatBody(
    {
      model: 'gpt-4',
      messages: [
        { role: 'user', content: `my password: ${PASSWORD}` },
        {
          role: 'assistant',
          tool_calls: [
            {
              id: '1',
              type: 'function',
              function: { name: 'login', arguments: JSON.stringify({ password: PASSWORD }) },
            },
          ],
        },
      ],
    },
    realScrub(),
  );
  const out = result.body as {
    messages: Array<{ content?: string; tool_calls?: Array<{ function: { arguments: string } }> }>;
  };
  t.is(out.messages[0]?.content, 'my password: «Secret_1»');
  t.is(out.messages[1]?.tool_calls?.[0]?.function.arguments, '{"password":"«Secret_1»"}');
});

test('leaves tool-call arguments under keys that do not name a secret untouched', (t) => {
  const body = {
    model: 'gpt-4',
    messages: [
      {
        role: 'assistant',
        tool_calls: [
          {
            id: '1',
            type: 'function',
            function: {
              name: 'search',
              arguments: JSON.stringify({ city: 'Berlin', title: 'a longer plain sentence here' }),
            },
          },
        ],
      },
    ],
  };
  const result = scrubOpenAIChatBody(body, realScrub());
  t.is(result.body, body);
  t.is(result.entities, 0);
});

test('a short value, or one with both quote kinds, under a secret-looking key does not break', (t) => {
  const args = { password: 'abc', token: `it's a "quoted" value` };
  const body = {
    model: 'gpt-4',
    messages: [
      {
        role: 'assistant',
        tool_calls: [
          { id: '1', type: 'function', function: { name: 'f', arguments: JSON.stringify(args) } },
        ],
      },
    ],
  };
  const result = scrubOpenAIChatBody(body, realScrub());
  t.is(result.body, body);
  t.is(result.entities, 0);
});
