import test from 'ava';
import {
  createSseRehydrator,
  rehydrateAnthropicJsonBody,
  rehydrateJsonBody,
  rehydrateOpenAIJsonBody,
} from '../../src/proxy/response-transform.js';

const SESSION = {
  '«Email_1»': 'alice@example.com',
  '«Secret_1»': 'sk-1234567890abcdef',
};

test('rehydrateOpenAIJsonBody replaces placeholders in message content', (t) => {
  const body = {
    id: 'chatcmpl-1',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'Hello «Email_1», your key is «Secret_1»' },
      },
    ],
  };
  const result = rehydrateOpenAIJsonBody(body, SESSION);
  t.is(result.placeholders, 2);
  const out = result.body as { choices: Array<{ message: { content: string } }> };
  t.is(out.choices[0]?.message.content, 'Hello alice@example.com, your key is sk-1234567890abcdef');
});

test('rehydrateOpenAIJsonBody is total when shape does not match', (t) => {
  const body = { foo: 'bar' };
  const result = rehydrateOpenAIJsonBody(body, SESSION);
  t.is(result.body, body);
  t.is(result.placeholders, 0);
});

test('rehydrateAnthropicJsonBody replaces placeholders only in text blocks', (t) => {
  const body = {
    id: 'msg_1',
    content: [
      { type: 'text', text: 'Hi «Email_1»' },
      { type: 'tool_use', id: 'tool_1', name: 'lookup', input: { q: '«Email_1»' } },
    ],
  };
  const result = rehydrateAnthropicJsonBody(body, SESSION);
  t.is(result.placeholders, 1);
  const out = result.body as {
    content: Array<{ type: string; text?: string; input?: { q: string } }>;
  };
  t.is(out.content[0]?.text, 'Hi alice@example.com');
  // tool_use.input is intentionally NOT rewritten — only text blocks are.
  t.deepEqual(out.content[1]?.input, { q: '«Email_1»' });
});

test('rehydrateJsonBody dispatches by provider', (t) => {
  const openai = rehydrateJsonBody(
    'openai',
    { choices: [{ message: { content: '«Email_1»' } }] },
    SESSION,
  );
  const anthropic = rehydrateJsonBody(
    'anthropic',
    { content: [{ type: 'text', text: '«Email_1»' }] },
    SESSION,
  );
  const unknown = rehydrateJsonBody(
    'unknown',
    { choices: [{ message: { content: '«Email_1»' } }] },
    SESSION,
  );
  t.is(openai.placeholders, 1);
  t.is(anthropic.placeholders, 1);
  t.is(unknown.placeholders, 0);
});

test('createSseRehydrator emits complete events and buffers incomplete tails', (t) => {
  const rehydrator = createSseRehydrator('openai', SESSION);

  // Two complete events in one chunk: the first contains a placeholder, the
  // second is a tool-call chunk with no placeholders.
  const chunk1 =
    'data: {"choices":[{"index":0,"delta":{"content":"Hi «Email_1»"}}]}\n\n' +
    'data: {"choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n';

  const out1 = rehydrator.push(Buffer.from(chunk1, 'utf8'));
  t.true(out1.includes('"content":"Hi alice@example.com"'));
  // Role-only chunk survives untouched.
  t.true(out1.includes('"role":"assistant"'));
  // The final blank line is preserved so the SSE framing stays intact.
  t.true(out1.endsWith('\n\n'));
});

test('createSseRehydrator keeps a partial event until the next chunk arrives', (t) => {
  const rehydrator = createSseRehydrator('openai', SESSION);

  // Split a single event across two chunks. The first chunk ends without a
  // blank line, so the rehydrator must hold it back.
  const part1 = 'data: {"choices":[{"index":0,"delta":{"content":"«Emai';
  const part2 = 'l_1»"}}]}\n\n';

  const out1 = rehydrator.push(Buffer.from(part1, 'utf8'));
  t.is(out1, '', 'incomplete event must not be emitted yet');

  const out2 = rehydrator.push(Buffer.from(part2, 'utf8'));
  t.true(out2.includes('alice@example.com'));
});

test('createSseRehydrator passes through [DONE] unchanged', (t) => {
  const rehydrator = createSseRehydrator('openai', SESSION);
  const out = rehydrator.push(Buffer.from('data: [DONE]\n\n', 'utf8'));
  t.true(out.includes('[DONE]'));
});

test('createSseRehydrator passes through non-JSON SSE payloads', (t) => {
  const rehydrator = createSseRehydrator('openai', SESSION);
  const out = rehydrator.push(Buffer.from('data: <html>not json</html>\n\n', 'utf8'));
  t.true(out.includes('<html>not json</html>'));
});

test('createSseRehydrator handles Anthropic content_block_delta events', (t) => {
  const rehydrator = createSseRehydrator('anthropic', SESSION);
  const chunk =
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Secret: «Secret_1»"}}\n\n';
  const out = rehydrator.push(Buffer.from(chunk, 'utf8'));
  t.true(out.includes('sk-1234567890abcdef'));
  t.false(out.includes('«Secret_1»'));
});

test('createSseRehydrator passes Anthropic non-delta events through untouched', (t) => {
  const rehydrator = createSseRehydrator('anthropic', SESSION);
  const chunk =
    'data: {"type":"message_start","message":{"id":"msg_1","content":[]}}\n\n' +
    'data: {"type":"ping"}\n\n';
  const out = rehydrator.push(Buffer.from(chunk, 'utf8'));
  t.true(out.includes('"type":"message_start"'));
  t.true(out.includes('"type":"ping"'));
});

test('createSseRehydrator flush() emits any trailing partial event', (t) => {
  const rehydrator = createSseRehydrator('openai', SESSION);
  // No terminating blank line — flush should still forward the bytes so the
  // client sees the final data point (some vendors omit the trailing \n\n).
  rehydrator.push(
    Buffer.from('data: {"choices":[{"index":0,"delta":{"content":"«Email_1»"}}]}', 'utf8'),
  );
  const tail = rehydrator.flush();
  t.true(tail.includes('alice@example.com'));
});

test('createSseRehydrator handles multibyte UTF-8 split across chunks', (t) => {
  const rehydrator = createSseRehydrator('openai', SESSION);
  // Build a string that contains a 3-byte UTF-8 char (✓ = E2 9C 93) split
  // across two chunks so we exercise the StringDecoder path.
  const full = 'data: {"choices":[{"index":0,"delta":{"content":"✓ «Email_1»"}}]}\n\n';
  const bytes = Buffer.from(full, 'utf8');
  const splitAt = bytes.indexOf(Buffer.from('✓')) + 1;
  const part1 = bytes.subarray(0, splitAt);
  const part2 = bytes.subarray(splitAt);

  const out1 = rehydrator.push(part1);
  t.is(out1, '');
  const out2 = rehydrator.push(part2);
  t.true(out2.includes('✓ alice@example.com'));
});

test('createSseRehydrator handles SSE comments and event: lines', (t) => {
  const rehydrator = createSseRehydrator('openai', SESSION);
  const chunk =
    ': keep-alive comment\n\nevent: message\ndata: {"choices":[{"delta":{"content":"«Email_1»"}}]}\n\n';
  const out = rehydrator.push(Buffer.from(chunk, 'utf8'));
  t.true(out.includes('keep-alive comment'));
  t.true(out.includes('event: message'));
  t.true(out.includes('alice@example.com'));
});

test('createSseRehydrator is total when no session entries match', (t) => {
  const rehydrator = createSseRehydrator('openai', {});
  const chunk = 'data: {"choices":[{"delta":{"content":"«Email_1»"}}]}\n\n';
  const out = rehydrator.push(Buffer.from(chunk, 'utf8'));
  // No rehydration occurred, so the placeholder survives in the output.
  t.true(out.includes('«Email_1»'));
});
