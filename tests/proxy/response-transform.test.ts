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

test('rehydrateAnthropicJsonBody replaces placeholders in text blocks and tool_use input', (t) => {
  const body = {
    id: 'msg_1',
    content: [
      { type: 'text', text: 'Hi «Email_1»' },
      { type: 'tool_use', id: 'tool_1', name: 'lookup', input: { q: '«Email_1»' } },
    ],
  };
  const result = rehydrateAnthropicJsonBody(body, SESSION);
  t.is(result.placeholders, 2);
  const out = result.body as {
    content: Array<{ type: string; text?: string; input?: { q: string } }>;
  };
  t.is(out.content[0]?.text, 'Hi alice@example.com');
  // The client executes this tool locally, so its input has to come back
  // real — a placeholder here would reach the caller's own code.
  t.deepEqual(out.content[1]?.input, { q: 'alice@example.com' });
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

/**
 * A session whose restored values contain characters that must be escaped
 * when they land inside a JSON string: a Windows path (backslashes) and a
 * quote. `C:\Users\alice` spliced in raw would make `arguments` unparseable.
 */
const ESCAPING_SESSION = {
  '«Path_1»': 'C:\\Users\\alice',
  '«Email_1»': 'alice@example.com',
  '«Name_1»': 'Alice "Al" Smith',
};

/** Pull the single `data:` payload out of an SSE block and parse it. */
function parseSseData(block: string): Record<string, unknown> {
  const line = block.split('\n').find((l) => l.startsWith('data:'));
  if (line === undefined) throw new Error(`no data line in ${JSON.stringify(block)}`);
  return JSON.parse(line.slice('data:'.length).trim()) as Record<string, unknown>;
}

test('rehydrateOpenAIJsonBody restores tool_call arguments', (t) => {
  const body = {
    id: 'chatcmpl-1',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'open', arguments: '{"path":"«Path_1»","to":"«Email_1»"}' },
            },
          ],
        },
      },
    ],
  };
  const result = rehydrateOpenAIJsonBody(body, ESCAPING_SESSION);
  t.is(result.placeholders, 2);
  const out = result.body as {
    choices: Array<{
      message: {
        content: null;
        tool_calls: Array<{ id: string; function: { name: string; arguments: string } }>;
      };
    }>;
  };
  const call = out.choices[0]?.message.tool_calls[0];
  t.is(call?.id, 'call_1');
  t.is(call?.function.name, 'open');
  t.is(out.choices[0]?.message.content, null, 'a null content stays null');
  // The guarantee that matters: still valid JSON, with the real values back.
  t.deepEqual(JSON.parse(call?.function.arguments ?? '{}'), {
    path: 'C:\\Users\\alice',
    to: 'alice@example.com',
  });
});

test('rehydrateOpenAIJsonBody escapes restored values that break JSON strings', (t) => {
  const body = {
    choices: [
      {
        message: {
          role: 'assistant',
          tool_calls: [
            {
              id: '1',
              type: 'function',
              function: { name: 'greet', arguments: '{"who":"«Name_1»"}' },
            },
          ],
        },
      },
    ],
  };
  const result = rehydrateOpenAIJsonBody(body, ESCAPING_SESSION);
  const out = result.body as {
    choices: Array<{ message: { tool_calls: Array<{ function: { arguments: string } }> } }>;
  };
  const args = out.choices[0]?.message.tool_calls[0]?.function.arguments ?? '';
  t.deepEqual(JSON.parse(args), { who: 'Alice "Al" Smith' }, 'embedded quotes stay escaped');
});

test('rehydrateOpenAIJsonBody leaves a tool call without placeholders untouched', (t) => {
  const body = {
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: '1', type: 'function', function: { name: 'f', arguments: '{"n": 1}' } },
          ],
        },
      },
    ],
  };
  const result = rehydrateOpenAIJsonBody(body, ESCAPING_SESSION);
  t.is(result.placeholders, 0);
  const out = result.body as {
    choices: Array<{ message: { tool_calls: Array<{ function: { arguments: string } }> } }>;
  };
  // Byte-identical: no reformatting of a payload we had nothing to restore in.
  t.is(out.choices[0]?.message.tool_calls[0]?.function.arguments, '{"n": 1}');
});

test('rehydrateAnthropicJsonBody restores nested tool_use input values', (t) => {
  const body = {
    id: 'msg_1',
    content: [
      {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'open',
        input: { path: '«Path_1»', meta: { cc: ['«Email_1»'] } },
      },
    ],
  };
  const result = rehydrateAnthropicJsonBody(body, ESCAPING_SESSION);
  t.is(result.placeholders, 2);
  const out = result.body as {
    content: Array<{ name: string; input: { path: string; meta: { cc: string[] } } }>;
  };
  t.is(out.content[0]?.name, 'open');
  t.is(out.content[0]?.input.path, 'C:\\Users\\alice');
  t.deepEqual(out.content[0]?.input.meta.cc, ['alice@example.com']);
});

test('createSseRehydrator restores streamed OpenAI tool-call argument fragments', (t) => {
  const rehydrator = createSseRehydrator('openai', ESCAPING_SESSION);
  const chunk =
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"open","arguments":"{\\"path\\":\\"«Path_1»\\"}"}}]}}]}\n\n';

  const out = rehydrator.push(Buffer.from(chunk, 'utf8'));
  const parsed = parseSseData(out) as {
    choices: Array<{ delta: { tool_calls: Array<{ function: { arguments: string } }> } }>;
  };
  const args = parsed.choices[0]?.delta.tool_calls[0]?.function.arguments ?? '';
  // The fragment is a slice of a JSON string, so the backslashes in the
  // restored path must come back escaped or this parse throws.
  t.deepEqual(JSON.parse(args), { path: 'C:\\Users\\alice' });
});

test('createSseRehydrator restores streamed Anthropic input_json_delta fragments', (t) => {
  const rehydrator = createSseRehydrator('anthropic', ESCAPING_SESSION);
  const chunk =
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"«Path_1»\\"}"}}\n\n';

  const out = rehydrator.push(Buffer.from(chunk, 'utf8'));
  const parsed = parseSseData(out) as { delta: { partial_json: string } };
  t.deepEqual(JSON.parse(parsed.delta.partial_json), { path: 'C:\\Users\\alice' });
});

test('createSseRehydrator leaves tool-call fragments without placeholders untouched', (t) => {
  const rehydrator = createSseRehydrator('openai', ESCAPING_SESSION);
  const chunk =
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"n\\":1}"}}]}}]}\n\n';
  const out = rehydrator.push(Buffer.from(chunk, 'utf8'));
  t.is(out, chunk, 'an untouched event is forwarded byte-for-byte');
});

/** Build an OpenAI streaming tool-call event carrying one argument fragment. */
function openAiArgEvent(fragment: string, callIndex = 0): string {
  return `data: ${JSON.stringify({
    choices: [
      {
        index: 0,
        delta: { tool_calls: [{ index: callIndex, function: { arguments: fragment } }] },
      },
    ],
  })}\n\n`;
}

/** Concatenate every streamed `arguments` fragment, as a client would. */
function collectArguments(sse: string): string {
  let out = '';
  for (const line of sse.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice('data: '.length).trim();
    if (payload === '[DONE]' || payload === '') continue;
    const parsed = JSON.parse(payload) as {
      choices?: Array<{ delta?: { tool_calls?: Array<{ function?: { arguments?: string } }> } }>;
      delta?: { partial_json?: string };
    };
    for (const call of parsed.choices?.[0]?.delta?.tool_calls ?? []) {
      out += call.function?.arguments ?? '';
    }
    out += parsed.delta?.partial_json ?? '';
  }
  return out;
}

test('createSseRehydrator restores a tool-call placeholder split across two events', (t) => {
  const rehydrator = createSseRehydrator('openai', ESCAPING_SESSION);
  // The common case: vendors emit roughly a token per event, so «Path_1»
  // arrives in pieces.
  const out =
    rehydrator.push(Buffer.from(openAiArgEvent('{"p":"«Pa'), 'utf8')) +
    rehydrator.push(Buffer.from(openAiArgEvent('th_1»"}'), 'utf8')) +
    rehydrator.flush();

  t.false(out.includes('«'), 'no placeholder fragment reaches the client');
  t.deepEqual(JSON.parse(collectArguments(out)), { p: 'C:\\Users\\alice' });
});

test('createSseRehydrator restores a placeholder split across three events', (t) => {
  const rehydrator = createSseRehydrator('openai', ESCAPING_SESSION);
  const out =
    rehydrator.push(Buffer.from(openAiArgEvent('{"to":"«Em'), 'utf8')) +
    rehydrator.push(Buffer.from(openAiArgEvent('ail'), 'utf8')) +
    rehydrator.push(Buffer.from(openAiArgEvent('_1»"}'), 'utf8')) +
    rehydrator.flush();

  t.deepEqual(JSON.parse(collectArguments(out)), { to: 'alice@example.com' });
});

test('createSseRehydrator keeps parallel tool calls apart', (t) => {
  const rehydrator = createSseRehydrator('openai', ESCAPING_SESSION);
  // Two calls streaming at once: a tail held for call 0 must not be spliced
  // into call 1's arguments.
  const out =
    rehydrator.push(Buffer.from(openAiArgEvent('{"p":"«Pa', 0), 'utf8')) +
    rehydrator.push(Buffer.from(openAiArgEvent('{"to":"«Em', 1), 'utf8')) +
    rehydrator.push(Buffer.from(openAiArgEvent('th_1»"}', 0), 'utf8')) +
    rehydrator.push(Buffer.from(openAiArgEvent('ail_1»"}', 1), 'utf8')) +
    rehydrator.flush();

  let first = '';
  let second = '';
  for (const line of out.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const parsed = JSON.parse(line.slice('data: '.length)) as {
      choices: Array<{
        delta: { tool_calls: Array<{ index: number; function: { arguments: string } }> };
      }>;
    };
    const call = parsed.choices[0]?.delta.tool_calls[0];
    if (call === undefined) continue;
    if (call.index === 0) first += call.function.arguments;
    else second += call.function.arguments;
  }
  t.deepEqual(JSON.parse(first), { p: 'C:\\Users\\alice' });
  t.deepEqual(JSON.parse(second), { to: 'alice@example.com' });
});

test('createSseRehydrator does not lose a tail when the stream ends mid-placeholder', (t) => {
  const rehydrator = createSseRehydrator('openai', ESCAPING_SESSION);
  // A truncated placeholder can never be resolved; the bytes must still
  // reach the client rather than being silently dropped.
  const out =
    rehydrator.push(Buffer.from(openAiArgEvent('{"p":"«Pa'), 'utf8')) + rehydrator.flush();
  t.is(collectArguments(out), '{"p":"«Pa', 'the held fragment is re-emitted verbatim');
});

test('createSseRehydrator does not hold back text that merely contains a guillemet', (t) => {
  const rehydrator = createSseRehydrator('openai', ESCAPING_SESSION);
  const chunk = openAiArgEvent('{"q":"il a dit « bonjour');
  const out = rehydrator.push(Buffer.from(chunk, 'utf8'));
  t.is(out, chunk, 'prose with a stray « streams on without buffering');
});

test('createSseRehydrator restores an Anthropic partial_json split across events', (t) => {
  const rehydrator = createSseRehydrator('anthropic', ESCAPING_SESSION);
  const event = (fragment: string) =>
    `data: ${JSON.stringify({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: fragment },
    })}\n\n`;

  const out =
    rehydrator.push(Buffer.from(event('{"p":"«Pa'), 'utf8')) +
    rehydrator.push(Buffer.from(event('th_1»"}'), 'utf8')) +
    rehydrator.flush();

  t.deepEqual(JSON.parse(collectArguments(out)), { p: 'C:\\Users\\alice' });
});

test('rehydrateOpenAIJsonBody escapes a restored value in unparseable arguments', (t) => {
  // Smaller models emit truncated argument blobs; the restored path must
  // still be escaped for the JSON string it sits in.
  const body = {
    choices: [
      {
        message: {
          role: 'assistant',
          tool_calls: [
            { id: '1', type: 'function', function: { name: 'open', arguments: '{"p":"«Path_1»"' } },
          ],
        },
      },
    ],
  };
  const result = rehydrateOpenAIJsonBody(body, ESCAPING_SESSION);
  const out = result.body as {
    choices: Array<{ message: { tool_calls: Array<{ function: { arguments: string } }> } }>;
  };
  const args = out.choices[0]?.message.tool_calls[0]?.function.arguments ?? '';
  t.is(args, '{"p":"C:\\\\Users\\\\alice"', 'backslashes stay escaped');
  // Closing the truncated blob yields valid JSON with the real value in it.
  t.deepEqual(JSON.parse(`${args}}`), { p: 'C:\\Users\\alice' });
});

test('rehydrateOpenAIJsonBody restores the deprecated function_call arguments', (t) => {
  const body = {
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          function_call: { name: 'open', arguments: '{"p":"«Path_1»"}' },
        },
      },
    ],
  };
  const result = rehydrateOpenAIJsonBody(body, ESCAPING_SESSION);
  t.is(result.placeholders, 1);
  const out = result.body as {
    choices: Array<{ message: { function_call: { name: string; arguments: string } } }>;
  };
  t.is(out.choices[0]?.message.function_call.name, 'open');
  t.deepEqual(JSON.parse(out.choices[0]?.message.function_call.arguments ?? '{}'), {
    p: 'C:\\Users\\alice',
  });
});

function contentEvent(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}`;
}

function sseStream(eol: string): string {
  return [
    `event: message${eol}${contentEvent('hello «Email_1»')}`,
    contentEvent('and bye'),
    'data: [DONE]',
  ]
    .map((event) => `${event}${eol}${eol}`)
    .join('');
}

function runSse(chunks: string[]): string {
  const rehydrator = createSseRehydrator('openai', SESSION);
  let out = '';
  for (const chunk of chunks) out += rehydrator.push(Buffer.from(chunk));
  return out + rehydrator.flush();
}

test('createSseRehydrator treats CRLF, CR and LF framing alike', (t) => {
  // `flush` ends with a blank event whose length depends on how the stream ended,
  // so compare the events and ignore trailing blank lines.
  const expected = runSse([sseStream('\n')]).trimEnd();
  t.true(expected.includes('hello alice@example.com'));
  t.is(runSse([sseStream('\r\n')]).trimEnd(), expected);
  t.is(runSse([sseStream('\r')]).trimEnd(), expected);
});

test('createSseRehydrator emits CRLF events as they arrive instead of at the end', (t) => {
  const rehydrator = createSseRehydrator('openai', SESSION);
  const first = rehydrator.push(Buffer.from(`${contentEvent('hi «Email_1»')}\r\n\r\n`));
  t.is(first, `${contentEvent('hi alice@example.com')}\n\n`);
  const second = rehydrator.push(Buffer.from(`${contentEvent('more')}\r\n\r\ndata: partial`));
  t.is(second, `${contentEvent('more')}\n\n`);
});

test('createSseRehydrator gives the same output wherever the chunks are split', (t) => {
  for (const eol of ['\r\n', '\r', '\n']) {
    const stream = sseStream(eol);
    const expected = runSse([stream]);
    for (let cut = 1; cut < stream.length; cut++) {
      t.is(
        runSse([stream.slice(0, cut), stream.slice(cut)]),
        expected,
        `${JSON.stringify(eol)} cut at ${cut}`,
      );
    }
    t.is(runSse(stream.split('')), expected, `${JSON.stringify(eol)} one character at a time`);
  }
});

test('createSseRehydrator does not mistake a CR LF pair for two line breaks', (t) => {
  const rehydrator = createSseRehydrator('openai', SESSION);
  t.is(rehydrator.push(Buffer.from(`${contentEvent('a')}\r`)), '');
  t.is(rehydrator.push(Buffer.from('\n')), '');
  t.is(rehydrator.push(Buffer.from('\r\n')), `${contentEvent('a')}\n\n`);
});

test('createSseRehydrator handles mixed line endings and a final event with no blank line', (t) => {
  const out = runSse([
    `${contentEvent('one «Email_1»')}\r\n\r\n`,
    `${contentEvent('two')}\n\n`,
    `${contentEvent('three')}\r\r`,
    'data: [DONE]',
  ]);
  t.true(out.includes('one alice@example.com'));
  t.true(out.includes('"content":"two"'));
  t.true(out.includes('"content":"three"'));
  t.true(out.trimEnd().endsWith('data: [DONE]'));
});

test('createSseRehydrator keeps non-data fields of a CRLF event', (t) => {
  const out = runSse([
    `id: 7\r\nevent: delta\r\n${contentEvent('x «Email_1»')}\r\nretry: 100\r\n\r\n`,
  ]);
  t.is(out.trimEnd(), `id: 7\nevent: delta\n${contentEvent('x alice@example.com')}\nretry: 100`);
});
