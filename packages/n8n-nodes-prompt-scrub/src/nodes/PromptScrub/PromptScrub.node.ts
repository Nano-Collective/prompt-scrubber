import { createRequire } from 'node:module';
import {
  type Finding,
  type InspectResult,
  inspect,
  rehydrate,
  type ScrubOptions,
  scrub,
} from '@nanocollective/prompt-scrub';
import type {
  IDataObject,
  IExecuteFunctions,
  INodeExecutionData,
  INodeProperties,
  INodeType,
  INodeTypeDescription,
} from 'n8n-workflow';
import {
  cloneJson,
  getValueAtPath,
  isMetadata,
  parseFieldPath,
  parseFieldPaths,
  setValueAtPath,
} from './fields.js';

// n8n currently exposes both CommonJS and ESM builds. Loading the error class
// through the host-compatible CommonJS condition keeps this community package
// executable in n8n and in direct Node-based tests.
const require = createRequire(import.meta.url);
const { NodeOperationError } = require('n8n-workflow') as {
  NodeOperationError: typeof import('n8n-workflow').NodeOperationError;
};

type Operation = 'inspect' | 'scrub' | 'scrubFields' | 'rehydrate';
type StorageMode = 'local' | 'inline';

interface PromptScrubMetadata {
  version: 1;
  operation: Operation;
  storage?: StorageMode;
  sessionId?: string;
  sessionMap?: Record<string, string>;
  detected?: {
    count: number;
    categories: Record<string, number>;
  };
  findings?: Array<{
    category: string;
    span: [number, number];
    placeholderPrefix: string;
    value?: string;
  }>;
  warnings?: string[];
}

interface ScrubRun {
  content: string;
  sessionId?: string;
  sessionMap?: Record<string, string>;
  detected: {
    count: number;
    categories: Record<string, number>;
  };
}

const operationOptions = [
  {
    name: 'Inspect',
    value: 'inspect',
    description: 'Detect sensitive values without changing the selected field.',
  },
  {
    name: 'Scrub',
    value: 'scrub',
    description: 'Replace sensitive values and create a session reference.',
  },
  {
    name: 'Scrub selected fields',
    value: 'scrubFields',
    description: 'Scrub only the selected string fields in each JSON item.',
  },
  {
    name: 'Rehydrate',
    value: 'rehydrate',
    description: 'Restore placeholders using a local session or inline session map.',
  },
];

const detectorOptions: INodeProperties = {
  displayName: 'Detector Options',
  name: 'detectorOptions',
  type: 'collection',
  default: {},
  options: [
    {
      displayName: 'Disable Detectors',
      name: 'disabledDetectors',
      type: 'string',
      default: '',
      placeholder: 'UrlDetector, PathDetector',
      description: 'Comma-separated detector names to skip.',
    },
    {
      displayName: 'Enable Detectors',
      name: 'enabledDetectors',
      type: 'string',
      default: '',
      placeholder: 'NameDetector, CodeTellDetector',
      description: 'Comma-separated off-by-default detector names to enable.',
    },
    {
      displayName: 'Strict Name Detector',
      name: 'strictNameDetector',
      type: 'boolean',
      default: false,
      description: 'Use the stricter allowlist when the name detector is enabled.',
    },
    {
      displayName: 'Code Tell Terms',
      name: 'codeTellTerms',
      type: 'string',
      default: '',
      placeholder: 'ProjectX, internalRouter',
      description: 'Comma-separated private identifiers to detect.',
    },
    {
      displayName: 'URL Allowlist',
      name: 'urlAllowlist',
      type: 'string',
      default: '',
      placeholder: 'docs.example.com, github.com',
      description: 'Comma-separated hostnames that should pass through.',
    },
  ],
};

const commonProperties: INodeProperties[] = [
  {
    displayName: 'Operation',
    name: 'operation',
    type: 'options',
    options: operationOptions,
    default: 'scrub',
    noDataExpression: true,
  },
  {
    displayName: 'Input Field',
    name: 'inputField',
    type: 'string',
    default: 'prompt',
    required: true,
    placeholder: 'prompt or response.text',
    description: 'Dot-separated path to the string field in the incoming JSON item.',
    displayOptions: {
      show: {
        operation: ['inspect', 'scrub', 'rehydrate'],
      },
    },
  },
  {
    displayName: 'Selected Fields',
    name: 'selectedFields',
    type: 'string',
    default: 'prompt',
    required: true,
    placeholder: 'prompt, customer.email, messages.0.content',
    description: 'Comma- or newline-separated paths to string fields to scrub.',
    displayOptions: {
      show: {
        operation: ['scrubFields'],
      },
    },
  },
  {
    displayName: 'Output Field',
    name: 'outputField',
    type: 'string',
    default: '',
    placeholder: 'sanitizedPrompt',
    description: 'Optional path for the transformed text. Blank replaces the input field.',
    displayOptions: {
      show: {
        operation: ['scrub', 'rehydrate'],
      },
    },
  },
  {
    displayName: 'Session Storage',
    name: 'sessionStorage',
    type: 'options',
    options: [
      {
        name: 'Local session (recommended)',
        value: 'local',
        description: 'Keep the map on the n8n worker and return only a session ID.',
      },
      {
        name: 'Inline session map',
        value: 'inline',
        description: 'Attach the map to workflow metadata for stateless workers.',
      },
    ],
    default: 'local',
    description:
      'Inline maps contain the original sensitive values. Do not pass the metadata field to an LLM.',
    displayOptions: {
      show: {
        operation: ['scrub', 'scrubFields'],
      },
    },
  },
  {
    displayName: 'Session ID',
    name: 'sessionId',
    type: 'string',
    default: '',
    placeholder: '={{$json._promptScrub.sessionId}}',
    description: 'Optional session ID. Leave empty to read it from the metadata field.',
    displayOptions: {
      show: {
        operation: ['rehydrate'],
      },
    },
  },
  {
    displayName: 'Metadata Field',
    name: 'metadataField',
    type: 'string',
    default: '_promptScrub',
    required: true,
    description:
      'Top-level field used for categories, warnings, and the session reference. Keep it out of LLM input.',
  },
  {
    displayName: 'Return Metadata',
    name: 'returnMetadata',
    type: 'boolean',
    default: true,
    description: 'Add operation metadata to each output item.',
  },
  {
    displayName: 'Include Detected Values',
    name: 'includeDetectedValues',
    type: 'boolean',
    default: false,
    description:
      'Include raw detected values in inspect metadata. Keep disabled for normal workflows.',
    displayOptions: {
      show: {
        operation: ['inspect'],
      },
    },
  },
  detectorOptions,
];

function getStringParameter(
  context: IExecuteFunctions,
  name: string,
  itemIndex: number,
  fallback = '',
): string {
  const value = context.getNodeParameter(name, itemIndex, fallback);
  return typeof value === 'string' ? value : fallback;
}

function getBooleanParameter(
  context: IExecuteFunctions,
  name: string,
  itemIndex: number,
  fallback: boolean,
): boolean {
  const value = context.getNodeParameter(name, itemIndex, fallback);
  return typeof value === 'boolean' ? value : fallback;
}

function parseList(value: string): string[] | undefined {
  const values = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return values.length > 0 ? values : undefined;
}

function getScrubOptions(context: IExecuteFunctions, itemIndex: number): ScrubOptions | undefined {
  const disabledDetectors = parseList(
    getStringParameter(context, 'detectorOptions.disabledDetectors', itemIndex),
  );
  const enabledDetectors = parseList(
    getStringParameter(context, 'detectorOptions.enabledDetectors', itemIndex),
  );
  const codeTellTerms = parseList(
    getStringParameter(context, 'detectorOptions.codeTellTerms', itemIndex),
  );
  const urlAllowlist = parseList(
    getStringParameter(context, 'detectorOptions.urlAllowlist', itemIndex),
  );
  const strictNameDetector = getBooleanParameter(
    context,
    'detectorOptions.strictNameDetector',
    itemIndex,
    false,
  );

  const options: ScrubOptions = {
    ...(disabledDetectors ? { disabledDetectors } : {}),
    ...(enabledDetectors ? { enabledDetectors } : {}),
    ...(codeTellTerms ? { codeTellTerms } : {}),
    ...(urlAllowlist ? { urlAllowlist } : {}),
    ...(strictNameDetector ? { strictNameDetector: true } : {}),
  };

  return Object.keys(options).length > 0 ? options : undefined;
}

function getOperation(value: string): Operation {
  if (
    value === 'inspect' ||
    value === 'scrub' ||
    value === 'scrubFields' ||
    value === 'rehydrate'
  ) {
    return value;
  }
  throw new Error(`Unsupported operation "${value}".`);
}

function getStorageMode(value: string): StorageMode {
  if (value === 'local' || value === 'inline') {
    return value;
  }
  throw new Error(`Unsupported session storage mode "${value}".`);
}

function requireTextField(item: INodeExecutionData, field: string): string {
  const path = parseFieldPath(field);
  const value = getValueAtPath(item.json, path);
  if (typeof value !== 'string') {
    throw new Error(`JSON field "${field}" must exist and contain a string.`);
  }
  return value;
}

function mergeCategories(target: Record<string, number>, categories: Record<string, number>): void {
  for (const [category, count] of Object.entries(categories)) {
    target[category] = (target[category] ?? 0) + count;
  }
}

function findingMetadata(
  findings: Finding[],
  includeValues: boolean,
): NonNullable<PromptScrubMetadata['findings']> {
  return findings.map((finding) => ({
    category: finding.category,
    span: [...finding.span] as [number, number],
    placeholderPrefix: finding.placeholderPrefix,
    ...(includeValues ? { value: finding.value } : {}),
  }));
}

function createDetectedMetadata(
  detected: ScrubRun['detected'],
  operation: Operation,
  storage?: StorageMode,
): PromptScrubMetadata {
  return {
    version: 1,
    operation,
    ...(storage ? { storage } : {}),
    detected,
  };
}

function createScrubRun(
  value: string,
  options: ScrubOptions | undefined,
  storage: StorageMode,
): ScrubRun {
  const inspected = inspect({ content: value, ...(options ? { options } : {}) });
  const sessionMap = storage === 'inline' ? {} : undefined;
  const result = scrub({
    content: value,
    ...(options ? { options } : {}),
    ...(sessionMap ? { sessionMap } : {}),
  });

  return {
    content: result.scrubbedContent as string,
    ...(result.sessionId ? { sessionId: result.sessionId } : {}),
    ...(sessionMap ? { sessionMap } : {}),
    detected: {
      count: inspected.findings.length,
      categories: inspected.categories,
    },
  };
}

function sessionMapFromMetadata(value: unknown): Record<string, string> | undefined {
  if (!isMetadata(value)) {
    return undefined;
  }

  const entries = Object.entries(value);
  if (entries.some(([, originalValue]) => typeof originalValue !== 'string')) {
    return undefined;
  }

  return Object.fromEntries(entries) as Record<string, string>;
}

function metadataForItem(item: INodeExecutionData, metadataField: string): Record<string, unknown> {
  const value = metadataField ? item.json[metadataField] : undefined;
  return isMetadata(value) ? value : {};
}

function validateMetadataField(value: string): string {
  const field = value.trim();
  if (!field) {
    return field;
  }

  const path = parseFieldPath(field);
  if (path.length !== 1) {
    throw new Error('Metadata Field must be a single top-level JSON field name.');
  }

  return path[0]!;
}

function setMetadata(
  json: IDataObject,
  metadataField: string,
  metadata: PromptScrubMetadata | Record<string, unknown>,
  returnMetadata: boolean,
): void {
  if (returnMetadata) {
    json[metadataField] = metadata;
  }
}

function outputItem(item: INodeExecutionData, json: IDataObject): INodeExecutionData {
  return { ...item, json, pairedItem: { item: 0 } };
}

function scrubItem(
  item: INodeExecutionData,
  inputField: string,
  outputField: string,
  metadataField: string,
  returnMetadata: boolean,
  options: ScrubOptions | undefined,
  storage: StorageMode,
): INodeExecutionData {
  const value = requireTextField(item, inputField);
  const run = createScrubRun(value, options, storage);
  const json = cloneJson(item.json);
  const destination = outputField || inputField;
  setValueAtPath(json, parseFieldPath(destination), run.content);

  const metadata = createDetectedMetadata(run.detected, 'scrub', storage);
  if (run.sessionId) {
    metadata.sessionId = run.sessionId;
  }
  if (run.sessionMap) {
    metadata.sessionMap = run.sessionMap;
  }
  setMetadata(json, metadataField, metadata, returnMetadata);

  return outputItem(item, json);
}

function scrubFieldsItem(
  item: INodeExecutionData,
  selectedFields: string,
  metadataField: string,
  returnMetadata: boolean,
  options: ScrubOptions | undefined,
  storage: StorageMode,
): INodeExecutionData {
  const paths = parseFieldPaths(selectedFields);
  const json = cloneJson(item.json);
  const sessionMap = storage === 'inline' ? {} : undefined;
  let sessionId: string | undefined;
  const detected = { count: 0, categories: {} as Record<string, number> };

  for (const path of paths) {
    const field = path.join('.');
    const value = requireTextField(item, field);
    const inspected = inspect({ content: value, ...(options ? { options } : {}) });
    detected.count += inspected.findings.length;
    mergeCategories(detected.categories, inspected.categories);

    const result = scrub({
      content: value,
      ...(options ? { options } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(sessionMap ? { sessionMap } : {}),
    });
    if (!sessionId && result.sessionId) {
      sessionId = result.sessionId;
    }
    setValueAtPath(json, path, result.scrubbedContent as string);
  }

  const metadata = createDetectedMetadata(detected, 'scrubFields', storage);
  if (sessionId) {
    metadata.sessionId = sessionId;
  }
  if (sessionMap) {
    metadata.sessionMap = sessionMap;
  }
  setMetadata(json, metadataField, metadata, returnMetadata);

  return outputItem(item, json);
}

function inspectItem(
  item: INodeExecutionData,
  inputField: string,
  metadataField: string,
  returnMetadata: boolean,
  includeDetectedValues: boolean,
  options: ScrubOptions | undefined,
): INodeExecutionData {
  const value = requireTextField(item, inputField);
  const result: InspectResult = inspect({ content: value, ...(options ? { options } : {}) });
  const json = cloneJson(item.json);
  const metadata = createDetectedMetadata(
    {
      count: result.findings.length,
      categories: result.categories,
    },
    'inspect',
  );
  metadata.findings = findingMetadata(result.findings, includeDetectedValues);
  setMetadata(json, metadataField, metadata, returnMetadata);

  return outputItem(item, json);
}

function rehydrateItem(
  item: INodeExecutionData,
  inputField: string,
  outputField: string,
  metadataField: string,
  manualSessionId: string,
  returnMetadata: boolean,
): INodeExecutionData {
  const value = requireTextField(item, inputField);
  const existingMetadata = metadataForItem(item, metadataField);
  const sessionId =
    manualSessionId ||
    (typeof existingMetadata.sessionId === 'string' ? existingMetadata.sessionId : '');
  const sessionMap = manualSessionId
    ? undefined
    : sessionMapFromMetadata(existingMetadata.sessionMap);

  if (!sessionId && !sessionMap) {
    throw new Error(
      `No session reference found. Provide a Session ID or preserve the "${metadataField}" metadata field.`,
    );
  }

  const result = rehydrate({
    content: value,
    ...(sessionId ? { sessionId } : {}),
    ...(sessionMap ? { sessionMap } : {}),
  });
  const json = cloneJson(item.json);
  setValueAtPath(json, parseFieldPath(outputField || inputField), result.content as string);

  const metadata: Record<string, unknown> = { ...existingMetadata, operation: 'rehydrate' };
  if (result.warnings) {
    metadata.warnings = result.warnings;
  } else {
    delete metadata.warnings;
  }
  setMetadata(json, metadataField, metadata, returnMetadata);

  return outputItem(item, json);
}

export class PromptScrub implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Prompt Scrub',
    name: 'promptScrub',
    icon: 'file:prompt-scrub.svg',
    group: ['transform'],
    version: 1,
    subtitle: '={{$parameter["operation"]}}',
    description:
      'Inspect, scrub, and rehydrate sensitive workflow data before and after an external LLM.',
    defaults: {
      name: 'Prompt Scrub',
    },
    inputs: ['main'],
    outputs: ['main'],
    properties: commonProperties,
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const output: INodeExecutionData[] = [];

    for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
      try {
        const operation = getOperation(getStringParameter(this, 'operation', itemIndex, 'scrub'));
        const returnMetadata = getBooleanParameter(this, 'returnMetadata', itemIndex, true);
        const metadataField = validateMetadataField(
          getStringParameter(this, 'metadataField', itemIndex, '_promptScrub'),
        );
        if (returnMetadata && !metadataField) {
          throw new Error('Metadata Field cannot be empty when Return Metadata is enabled.');
        }

        const options = getScrubOptions(this, itemIndex);
        const item = items[itemIndex]!;
        let result: INodeExecutionData;

        if (operation === 'inspect') {
          result = inspectItem(
            item,
            getStringParameter(this, 'inputField', itemIndex, 'prompt'),
            metadataField,
            returnMetadata,
            getBooleanParameter(this, 'includeDetectedValues', itemIndex, false),
            options,
          );
        } else if (operation === 'scrub') {
          result = scrubItem(
            item,
            getStringParameter(this, 'inputField', itemIndex, 'prompt'),
            getStringParameter(this, 'outputField', itemIndex),
            metadataField,
            returnMetadata,
            options,
            getStorageMode(getStringParameter(this, 'sessionStorage', itemIndex, 'local')),
          );
        } else if (operation === 'scrubFields') {
          result = scrubFieldsItem(
            item,
            getStringParameter(this, 'selectedFields', itemIndex, 'prompt'),
            metadataField,
            returnMetadata,
            options,
            getStorageMode(getStringParameter(this, 'sessionStorage', itemIndex, 'local')),
          );
        } else {
          result = rehydrateItem(
            item,
            getStringParameter(this, 'inputField', itemIndex, 'response'),
            getStringParameter(this, 'outputField', itemIndex),
            metadataField,
            getStringParameter(this, 'sessionId', itemIndex).trim(),
            returnMetadata,
          );
        }

        result.pairedItem = { item: itemIndex };
        output.push(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (this.continueOnFail()) {
          output.push({
            json: { error: message },
            pairedItem: { item: itemIndex },
          });
          continue;
        }

        throw new NodeOperationError(this.getNode(), message, { itemIndex });
      }
    }

    return [output];
  }
}
