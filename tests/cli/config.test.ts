import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'ava';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliEntry = path.resolve(__dirname, '../../src/cli/index.ts');
const tmpRoot = path.join(__dirname, '.tmp-config-cmd');

let counter = 0;

function makeConfigDir(): string {
  counter += 1;
  const dir = path.join(tmpRoot, `case-${counter}`, 'prompt-scrub');
  fs.rmSync(dir, { recursive: true, force: true });
  return dir;
}

function runCli(configDir: string, args: string[], input?: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', cliEntry, ...args], {
    input,
    encoding: 'utf-8',
    env: { ...process.env, PROMPT_SCRUB_CONFIG_DIR: configDir },
  });
}

function writeRawConfig(configDir: string, contents: string) {
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), contents, 'utf8');
}

test.before(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test.after.always(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('CLI: init creates a default config file and its parent directories', (t) => {
  const configDir = makeConfigDir();
  const result = runCli(configDir, ['init']);

  t.is(result.status, 0);
  t.true(result.stdout.includes('Created config file at'));

  const configPath = path.join(configDir, 'config.json');
  t.true(fs.existsSync(configPath));
  t.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), {
    rulePacks: [],
    urlAllowlist: [],
    sessionTtlDays: 7,
    encryptionEnabled: false,
  });
});

test('CLI: init refuses to overwrite an existing config file', (t) => {
  const configDir = makeConfigDir();
  writeRawConfig(configDir, '{"rulePacks":["keep-me"]}');

  const result = runCli(configDir, ['init']);

  t.is(result.status, 1);
  t.true(result.stderr.includes('already exists'));
  t.true(result.stderr.includes('--force'));
  t.true(fs.readFileSync(path.join(configDir, 'config.json'), 'utf8').includes('keep-me'));
});

test('CLI: init --force overwrites an existing config file', (t) => {
  const configDir = makeConfigDir();
  writeRawConfig(configDir, '{"rulePacks":["stale"],"bogus":1}');

  const result = runCli(configDir, ['init', '--force']);

  t.is(result.status, 0);
  t.deepEqual(JSON.parse(fs.readFileSync(path.join(configDir, 'config.json'), 'utf8')), {
    rulePacks: [],
    urlAllowlist: [],
    sessionTtlDays: 7,
    encryptionEnabled: false,
  });
});

test('CLI: init --force creates the file when none exists', (t) => {
  const configDir = makeConfigDir();
  const result = runCli(configDir, ['init', '--force']);

  t.is(result.status, 0);
  t.true(fs.existsSync(path.join(configDir, 'config.json')));
});

test('CLI: config show prints defaults and a hint when no config file exists', (t) => {
  const configDir = makeConfigDir();
  const result = runCli(configDir, ['config', 'show']);

  t.is(result.status, 0);
  t.deepEqual(JSON.parse(result.stdout), {
    rulePacks: [],
    urlAllowlist: [],
    sessionTtlDays: 7,
    encryptionEnabled: false,
  });
  t.true(result.stderr.includes('No config file at'));
  t.true(result.stderr.includes('prompt-scrub init'));
});

test('CLI: config show prints the active configuration and its path', (t) => {
  const configDir = makeConfigDir();
  writeRawConfig(
    configDir,
    JSON.stringify({ rulePacks: ['pack-a'], urlAllowlist: ['example.com'] }),
  );

  const result = runCli(configDir, ['config', 'show']);

  t.is(result.status, 0);
  t.deepEqual(JSON.parse(result.stdout), {
    rulePacks: ['pack-a'],
    urlAllowlist: ['example.com'],
    sessionTtlDays: 7,
    encryptionEnabled: false,
  });
  t.true(result.stderr.includes(path.join(configDir, 'config.json')));
});

test('CLI: config show reports invalid JSON', (t) => {
  const configDir = makeConfigDir();
  writeRawConfig(configDir, '{ not json ');

  const result = runCli(configDir, ['config', 'show']);

  t.is(result.status, 1);
  t.true(result.stderr.includes('Invalid JSON'));
  t.deepEqual(JSON.parse(result.stdout), {
    rulePacks: [],
    urlAllowlist: [],
    sessionTtlDays: 7,
    encryptionEnabled: false,
  });
});

test('CLI: config show reports an empty config file', (t) => {
  const configDir = makeConfigDir();
  writeRawConfig(configDir, '');

  const result = runCli(configDir, ['config', 'show']);

  t.is(result.status, 1);
  t.true(result.stderr.includes('Invalid JSON'));
});

test('CLI: config show reports an unreadable config file', (t) => {
  const configDir = makeConfigDir();
  fs.mkdirSync(path.join(configDir, 'config.json'), { recursive: true });

  const result = runCli(configDir, ['config', 'show']);

  t.is(result.status, 1);
  t.true(result.stderr.includes('Could not read file'));
});

test('CLI: config show reports a non-object root', (t) => {
  const configDir = makeConfigDir();
  writeRawConfig(configDir, '["pack-a"]');

  const result = runCli(configDir, ['config', 'show']);

  t.is(result.status, 1);
  t.true(result.stderr.includes('Expected a JSON object, received an array'));
});

test('CLI: config show reports a null root', (t) => {
  const configDir = makeConfigDir();
  writeRawConfig(configDir, 'null');

  const result = runCli(configDir, ['config', 'show']);

  t.is(result.status, 1);
  t.true(result.stderr.includes('Expected a JSON object, received null'));
});

test('CLI: config show reports unknown keys', (t) => {
  const configDir = makeConfigDir();
  writeRawConfig(configDir, JSON.stringify({ rulePaks: ['typo'] }));

  const result = runCli(configDir, ['config', 'show']);

  t.is(result.status, 1);
  t.true(result.stderr.includes('Unknown key "rulePaks"'));
  t.true(result.stderr.includes('rulePacks, urlAllowlist'));
});

test('CLI: config show reports keys with the wrong type', (t) => {
  const configDir = makeConfigDir();
  writeRawConfig(configDir, JSON.stringify({ rulePacks: 'pack-a', urlAllowlist: {} }));

  const result = runCli(configDir, ['config', 'show']);

  t.is(result.status, 1);
  t.true(result.stderr.includes('"rulePacks" must be an array of strings, received string'));
  t.true(result.stderr.includes('"urlAllowlist" must be an array of strings, received object'));
});

test('CLI: config show reports non-string array members and drops them', (t) => {
  const configDir = makeConfigDir();
  writeRawConfig(configDir, JSON.stringify({ rulePacks: ['pack-a', 42, null] }));

  const result = runCli(configDir, ['config', 'show']);

  t.is(result.status, 1);
  t.true(result.stderr.includes('"rulePacks" must contain only strings'));
  t.deepEqual(JSON.parse(result.stdout), {
    rulePacks: ['pack-a'],
    urlAllowlist: [],
    sessionTtlDays: 7,
    encryptionEnabled: false,
  });
});

test('CLI: config show deduplicates repeated entries', (t) => {
  const configDir = makeConfigDir();
  writeRawConfig(configDir, JSON.stringify({ urlAllowlist: ['example.com', 'example.com'] }));

  const result = runCli(configDir, ['config', 'show']);

  t.is(result.status, 0);
  t.deepEqual(JSON.parse(result.stdout), {
    rulePacks: [],
    urlAllowlist: ['example.com'],
    sessionTtlDays: 7,
    encryptionEnabled: false,
  });
});

test('CLI: init output round-trips through config show', (t) => {
  const configDir = makeConfigDir();
  t.is(runCli(configDir, ['init']).status, 0);

  const result = runCli(configDir, ['config', 'show']);
  t.is(result.status, 0);
  t.deepEqual(JSON.parse(result.stdout), {
    rulePacks: [],
    urlAllowlist: [],
    sessionTtlDays: 7,
    encryptionEnabled: false,
  });
});

test('CLI: a configured urlAllowlist is applied when scrubbing', (t) => {
  const configDir = makeConfigDir();
  writeRawConfig(configDir, JSON.stringify({ urlAllowlist: ['example.com'] }));

  const result = runCli(
    configDir,
    ['scrub'],
    'See https://docs.example.com/a and https://other.io/b',
  );

  t.is(result.status, 0);
  t.is(result.stdout, 'See https://docs.example.com/a and «Url_1»');
});

test('CLI: a malformed config file does not break scrubbing', (t) => {
  const configDir = makeConfigDir();
  writeRawConfig(configDir, '{ not json ');

  const result = runCli(configDir, ['scrub'], 'Contact me at alice@example.com');

  t.is(result.status, 0);
  t.is(result.stdout, 'Contact me at «Email_1»');
});

test('CLI: help lists the init and config commands', (t) => {
  const configDir = makeConfigDir();
  const result = runCli(configDir, ['--help']);

  t.is(result.status, 0);
  t.true(result.stdout.includes('init'));
  t.true(result.stdout.includes('config'));
});
