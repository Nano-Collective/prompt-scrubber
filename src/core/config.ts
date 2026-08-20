import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LOCALE_PATTERN } from './locale.js';

export interface PromptScrubConfig {
  rulePacks?: string[];
  urlAllowlist?: string[];
  sessionTtlDays?: number;
  locale?: string;
}

export interface ConfigFileState {
  path: string;
  exists: boolean;
  errors: string[];
  config: PromptScrubConfig;
}

export function createDefaultConfig(): Required<PromptScrubConfig> {
  return {
    rulePacks: [],
    urlAllowlist: [],
    sessionTtlDays: 7,
    locale: '',
  };
}

const CONFIG_SCHEMA = createDefaultConfig();
const CONFIG_KEYS = Object.keys(CONFIG_SCHEMA);

/**
 * Determines the base configuration directory based on the OS.
 *
 * An explicit override via the `PROMPT_SCRUB_CONFIG_DIR` environment variable
 * always takes precedence. This is primarily intended for tests, but it also
 * lets users relocate the storage directory on any platform.
 */
export function getConfigDir(): string {
  const override = process.env.PROMPT_SCRUB_CONFIG_DIR;
  if (override && override.length > 0) {
    return override;
  }

  const platform = process.env.MOCK_PLATFORM || os.platform();
  const homedir = os.homedir();

  if (platform === 'darwin') {
    return path.join(homedir, 'Library', 'Application Support', 'prompt-scrub');
  } else if (platform === 'win32') {
    return path.join(
      process.env.APPDATA || path.join(homedir, 'AppData', 'Roaming'),
      'prompt-scrub',
    );
  } else {
    // Linux and others
    return path.join(process.env.XDG_CONFIG_HOME || path.join(homedir, '.config'), 'prompt-scrub');
  }
}

function getConfigPath(): string {
  return path.join(getConfigDir(), 'config.json');
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter((item): item is string => typeof item === 'string')));
}

function toLocale(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return LOCALE_PATTERN.test(trimmed) ? trimmed : '';
}

function validateConfig(data: unknown): string[] {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return [`Expected a JSON object, received ${describeType(data)}.`];
  }

  const errors: string[] = [];
  const record = data as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (!CONFIG_KEYS.includes(key)) {
      errors.push(`Unknown key "${key}". Supported keys: ${CONFIG_KEYS.join(', ')}.`);
    }
  }

  for (const key of CONFIG_KEYS) {
    const value = record[key];
    if (value === undefined) continue;

    const expected = CONFIG_SCHEMA[key as keyof PromptScrubConfig];

    if (Array.isArray(expected)) {
      if (!Array.isArray(value)) {
        errors.push(`"${key}" must be an array of strings, received ${describeType(value)}.`);
      } else if (value.some((item) => typeof item !== 'string')) {
        errors.push(`"${key}" must contain only strings.`);
      }
      continue;
    }

    if (typeof expected === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        errors.push(`"${key}" must be a positive number, received ${describeType(value)}.`);
      }
      continue;
    }

    if (typeof value !== 'string') {
      errors.push(`"${key}" must be a string, received ${describeType(value)}.`);
    } else if (key === 'locale' && value.trim().length > 0 && !LOCALE_PATTERN.test(value.trim())) {
      errors.push(`"locale" must be a BCP-47 language tag (e.g. "de-DE"), received "${value}".`);
    }
  }

  return errors;
}

export function readConfigFile(): ConfigFileState {
  const configPath = getConfigPath();

  if (!fs.existsSync(configPath)) {
    return { path: configPath, exists: false, errors: [], config: createDefaultConfig() };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    const reason = error instanceof SyntaxError ? 'Invalid JSON' : 'Could not read file';
    return {
      path: configPath,
      exists: true,
      errors: [`${reason}: ${(error as Error).message}`],
      config: createDefaultConfig(),
    };
  }

  const record =
    parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};

  return {
    path: configPath,
    exists: true,
    errors: validateConfig(parsed),
    config: {
      rulePacks: toStringArray(record.rulePacks),
      urlAllowlist: toStringArray(record.urlAllowlist),
      sessionTtlDays:
        typeof record.sessionTtlDays === 'number' &&
        Number.isFinite(record.sessionTtlDays) &&
        record.sessionTtlDays > 0
          ? record.sessionTtlDays
          : 7,
      locale: toLocale(record.locale),
    },
  };
}

export function writeConfig(config: PromptScrubConfig): string {
  const configPath = getConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  return configPath;
}

/**
 * Reads configuration from ~/.config/prompt-scrub/config.json, dropping any
 * entries that do not match the schema.
 */
export function loadConfig(): PromptScrubConfig {
  return readConfigFile().config;
}
