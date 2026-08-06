import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'ava';
import type { IDataObject, IExecuteFunctions, INode, INodeExecutionData } from 'n8n-workflow';
import { PromptScrub } from '../src/nodes/PromptScrub/PromptScrub.node.js';

const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-scrub-n8n-'));
process.env.PROMPT_SCRUB_CONFIG_DIR = configDir;

test.after.always(() => {
  fs.rmSync(configDir, { recursive: true, force: true });
});

function makeNode(): INode {
  return {
    id: 'prompt-scrub-test',
    name: 'Prompt Scrub',
    type: 'n8n-nodes-prompt-scrub.promptScrub',
    typeVersion: 1,
    position: [0, 0],
    parameters: {},
  };
}

function makeContext(
  parameters: Record<string, unknown>,
  items: INodeExecutionData[],
): IExecuteFunctions {
  return {
    getInputData: () => items,
    getNodeParameter: (name: string, _itemIndex: number, fallback?: unknown) =>
      name in parameters ? parameters[name] : fallback,
    getNode: makeNode,
    continueOnFail: () => false,
  } as unknown as IExecuteFunctions;
}

async function execute(
  parameters: Record<string, unknown>,
  items: INodeExecutionData[],
): Promise<INodeExecutionData[]> {
  const node = new PromptScrub();
  const result = await node.execute!.call(makeContext(parameters, items));
  return result[0] ?? [];
}

function jsonItem(json: IDataObject): INodeExecutionData {
  return { json };
}

test('scrub returns a local session reference without copying raw values to metadata', async (t) => {
  const [result] = await execute(
    {
      operation: 'scrub',
      inputField: 'prompt',
      metadataField: '_promptScrub',
      returnMetadata: true,
      sessionStorage: 'local',
    },
    [
      {
        ...jsonItem({ prompt: 'Contact alice@example.com' }),
        binary: {
          attachment: {
            data: 'encoded-content',
            mimeType: 'text/plain',
          },
        },
      },
    ],
  );

  t.truthy(result);
  t.is(result?.json.prompt, 'Contact «Email_1»');
  t.is(result?.binary?.attachment?.data, 'encoded-content');
  const metadata = result?.json._promptScrub as Record<string, unknown>;
  t.is(metadata.storage, 'local');
  t.is((metadata.detected as Record<string, unknown>).count, 1);
  t.is(typeof metadata.sessionId, 'string');
  t.false(JSON.stringify(metadata).includes('alice@example.com'));
});

test('rehydrate reads the session reference from metadata', async (t) => {
  const [scrubbed] = await execute(
    {
      operation: 'scrub',
      inputField: 'prompt',
      metadataField: '_promptScrub',
      returnMetadata: true,
      sessionStorage: 'local',
    },
    [jsonItem({ prompt: 'Contact alice@example.com' })],
  );

  const [rehydrated] = await execute(
    {
      operation: 'rehydrate',
      inputField: 'response',
      metadataField: '_promptScrub',
      returnMetadata: true,
    },
    [
      jsonItem({
        response: 'The customer is «Email_1».',
        _promptScrub: scrubbed?.json._promptScrub,
      }),
    ],
  );

  t.truthy(rehydrated);
  if (!rehydrated) return;
  t.is(rehydrated.json.response, 'The customer is alice@example.com.');
  t.is((rehydrated.json._promptScrub as Record<string, unknown>).operation, 'rehydrate');
});

test('scrub selected fields supports nested paths and inline maps', async (t) => {
  const [scrubbed] = await execute(
    {
      operation: 'scrubFields',
      selectedFields: 'prompt,customer.email',
      metadataField: '_promptScrub',
      returnMetadata: true,
      sessionStorage: 'inline',
    },
    [
      jsonItem({
        prompt: 'Email alice@example.com',
        customer: { email: 'bob@example.com' },
        untouched: 'alice@example.com',
      }),
    ],
  );

  t.truthy(scrubbed);
  if (!scrubbed) return;
  t.is(scrubbed.json.prompt, 'Email «Email_1»');
  t.deepEqual((scrubbed.json.customer as IDataObject).email, '«Email_2»');
  t.is(scrubbed.json.untouched, 'alice@example.com');

  const metadata = scrubbed?.json._promptScrub as Record<string, unknown>;
  t.deepEqual(metadata.sessionMap, {
    '«Email_1»': 'alice@example.com',
    '«Email_2»': 'bob@example.com',
  });

  const [rehydrated] = await execute(
    {
      operation: 'rehydrate',
      inputField: 'response',
      metadataField: '_promptScrub',
      returnMetadata: true,
    },
    [
      jsonItem({
        response: '«Email_1» and «Email_2»',
        _promptScrub: metadata,
      }),
    ],
  );

  t.is(rehydrated?.json.response, 'alice@example.com and bob@example.com');
});

test('inspect leaves the selected field unchanged and omits values by default', async (t) => {
  const [result] = await execute(
    {
      operation: 'inspect',
      inputField: 'prompt',
      metadataField: '_promptScrub',
      returnMetadata: true,
      includeDetectedValues: false,
    },
    [jsonItem({ prompt: 'Contact alice@example.com' })],
  );

  t.is(result?.json.prompt, 'Contact alice@example.com');
  const metadata = result?.json._promptScrub as Record<string, unknown>;
  t.deepEqual((metadata.detected as Record<string, unknown>).categories, { Email: 1 });
  t.false(JSON.stringify(metadata).includes('alice@example.com'));
});

test('rejects unsafe or nested metadata field names', async (t) => {
  const unsafe = execute(
    {
      operation: 'inspect',
      inputField: 'prompt',
      metadataField: '__proto__',
      returnMetadata: true,
    },
    [jsonItem({ prompt: 'Contact alice@example.com' })],
  );
  await t.throwsAsync(unsafe, { message: /forbidden segment/ });

  const nested = execute(
    {
      operation: 'inspect',
      inputField: 'prompt',
      metadataField: 'workflow.metadata',
      returnMetadata: true,
    },
    [jsonItem({ prompt: 'Contact alice@example.com' })],
  );
  await t.throwsAsync(nested, { message: /single top-level JSON field/ });
});
