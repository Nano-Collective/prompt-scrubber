import type { Command } from 'commander';
import { runProxy } from '../../proxy/index.js';
import type { ScrubCliOptions } from '../../proxy/types.js';
import { loadConfig } from '../../core/config.js';
import { gcSessions } from '../../session/storage.js';

interface ProxyCommandOptions extends ScrubCliOptions {
  target: string;
  port: string;
  host?: string;
  verbose?: boolean;
  noGc?: boolean;
}

function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function runProxyCommand(options: ProxyCommandOptions): Promise<void> {
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

  // Garbage-collect expired sessions before we start, unless told not to.
  // This keeps long-running proxies from accumulating stale maps.
  if (!options.noGc) {
    try {
      const config = loadConfig();
      gcSessions(config.sessionTtlDays ?? 7);
    } catch (err) {
      console.error(
        `[proxy] Warning: failed to run session garbage collection: ${(err as Error).message}`,
      );
    }
  }

  // Merge CLI + config-supplied allowlists so users get the same defaults as
  // the standalone `scrub` command.
  const config = loadConfig();
  const cliUrlAllowlist = parseList(options.urlAllowlist);
  const urlAllowlist = Array.from(new Set([...(config.urlAllowlist || []), ...cliUrlAllowlist]));

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
    .option('--no-gc', 'Skip the startup session-garbage-collection pass')
    .action(async (options: ProxyCommandOptions) => {
      try {
        await runProxyCommand(options);
      } catch (err: unknown) {
        console.error(`[proxy] ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
