import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Command } from 'commander';
import { runProxy } from '../../proxy/proxy-server.js';
import type { ScrubCliOptions } from '../../proxy/types.js';
import { loadConfig } from '../../core/config.js';
import { gcSessions } from '../../session/storage.js';

interface ProxyCommandOptions extends ScrubCliOptions {
  target: string;
  port: string;
  host?: string;
  verbose?: boolean;
  /** Path to an append-only JSONL audit file. */
  auditLog?: string;
  /** True unless `--no-metrics` was passed. */
  metrics?: boolean;
  /** Version string reported by `/healthz` and `/metrics`. */
  version?: string;
  /** True when `--gc` was passed; defaults to true. `--no-gc` flips this off. */
  gc?: boolean;
  /** False when `--no-reload-config` was passed. */
  reloadConfig?: boolean;
}

function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function runProxyCommand(options: ProxyCommandOptions): Promise<void> {
  if (!options.target) {
    throw new Error('Missing required --target <url> option.');
  }

  let target: URL;
  try {
    target = new URL(options.target);
  } catch (err) {
    throw new Error(`Invalid --target URL "${options.target}": ${(err as Error).message}`);
  }

  const port = Number.parseInt(options.port, 10);
  if (!Number.isFinite(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid --port "${options.port}". Use a number between 0 and 65535.`);
  }

  const host = options.host ?? '127.0.0.1';
  if (!/^[a-z0-9.\-:[\]]+$/i.test(host)) {
    throw new Error(`Invalid --host "${host}".`);
  }

  let auditLog: string | undefined;
  if (options.auditLog !== undefined) {
    if (options.auditLog.trim() === '') {
      throw new Error('Invalid --audit-log: the path must not be empty.');
    }
    auditLog = path.resolve(options.auditLog);
    if (fs.existsSync(auditLog) && fs.statSync(auditLog).isDirectory()) {
      throw new Error(`Invalid --audit-log "${options.auditLog}": path is a directory.`);
    }
  }

  // Garbage-collect expired sessions before we start, unless told not to.
  // This keeps long-running proxies from accumulating stale maps.
  if (options.gc !== false) {
    try {
      const config = loadConfig();
      gcSessions(config.sessionTtlDays ?? 7);
    } catch (err) {
      console.error(
        `[proxy] Warning: failed to run session garbage collection: ${(err as Error).message}`,
      );
    }
  }

  // The config-file allowlist is merged inside the server, so it can be
  // reloaded. Only the flag value is passed here.
  const urlAllowlist = parseList(options.urlAllowlist);

  const disable = parseList(options.disable).join(',');
  const enable = parseList(options.enable).join(',');
  const codeTellTerms = parseList(options.codeTellTerms).join(',');

  const scrubOptions: ScrubCliOptions = {};
  if (disable) scrubOptions.disable = disable;
  if (enable) scrubOptions.enable = enable;
  if (options.strictName !== undefined) scrubOptions.strictName = options.strictName;
  if (codeTellTerms) scrubOptions.codeTellTerms = codeTellTerms;
  if (urlAllowlist.length > 0) scrubOptions.urlAllowlist = urlAllowlist.join(',');

  await runProxy({
    target,
    port,
    host,
    verbose: options.verbose ?? false,
    reloadConfig: options.reloadConfig !== false,
    metrics: options.metrics !== false,
    ...(auditLog !== undefined ? { auditLog } : {}),
    ...(options.version !== undefined ? { version: options.version } : {}),
    ...(Object.keys(scrubOptions).length > 0 ? { scrubOptions } : {}),
  });
}

export function setupProxyCommand(program: Command) {
  program
    .command('proxy')
    .description(
      'Run a local HTTP proxy that scrubs outgoing LLM requests and rehydrates responses transparently',
    )
    .requiredOption(
      '--target <url>',
      'Upstream base URL, e.g. https://api.openai.com or https://api.anthropic.com',
    )
    .option('--port <port>', 'Local port to listen on (use 0 for a random free port)', '8080')
    .option('--host <host>', 'Local host to bind (defaults to 127.0.0.1)')
    .option('--disable <detectors>', 'Comma-separated list of detector names to skip')
    .option(
      '--enable <detectors>',
      'Comma-separated list of off-by-default detectors to enable (e.g., NameDetector)',
    )
    .option('--strict-name', 'Enable strict allowlisting for NameDetector')
    .option(
      '--code-tell-terms <terms>',
      'Comma-separated list of private identifiers to detect (enables CodeTellDetector)',
    )
    .option(
      '--url-allowlist <hosts>',
      'Comma-separated list of hostnames to pass-through in URLs (subdomains are implicitly allowed)',
    )
    .option('-v, --verbose', 'Log a one-line summary of every proxied request to stderr')
    .option('--no-reload-config', 'Do not reload config.json on SIGHUP or when it changes on disk')
    .option(
      '--audit-log <path>',
      'Append one JSON line per request to this file (counts and categories only, never values)',
    )
    .option('--no-metrics', 'Do not serve /healthz and /metrics; forward those paths upstream')
    .option('--no-gc', 'Skip the startup session-garbage-collection pass')
    .action(async (options: ProxyCommandOptions) => {
      try {
        await runProxyCommand({ ...options, version: program.version() ?? 'unknown' });
      } catch (err: unknown) {
        console.error(`[proxy] ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
