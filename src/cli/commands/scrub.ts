import { readFileSync } from 'node:fs';
import type { Command } from 'commander';
import { resolveEncryptionKeyOrExit } from '../../core/cli-key-resolver.js';
import { loadConfig } from '../../core/config.js';
import { isSessionEncrypted } from '../../session/storage.js';

import { loadConfiguredRulePacks } from '../../core/rule-packs.js';
import { scrub } from '../../core/scrub.js';
import { gcSessions } from '../../session/storage.js';
import type { ScrubStats } from '../../types/index.js';

export async function handleScrub(
  text: string,
  options: {
    sessionId?: string;
    disable?: string;
    enable?: string;
    strictName?: boolean;
    codeTellTerms?: string;
    urlAllowlist?: string;
  },
) {
  const disabledDetectors = options.disable ? options.disable.split(',').map((s) => s.trim()) : [];
  const enabledDetectors = options.enable ? options.enable.split(',').map((s) => s.trim()) : [];
  const codeTellTerms = options.codeTellTerms
    ? options.codeTellTerms.split(',').map((s) => s.trim())
    : undefined;

  const cliUrlAllowlist = options.urlAllowlist
    ? options.urlAllowlist.split(',').map((s) => s.trim())
    : [];

  const config = loadConfig();

  try {
    gcSessions(config.sessionTtlDays ?? 7);
  } catch (e) {
    console.error(`Warning: Failed to run session garbage collection: ${(e as Error).message}`);
  }

  const urlAllowlist = Array.from(new Set([...(config.urlAllowlist || []), ...cliUrlAllowlist]));

  const { detectors: rulePackDetectors } = await loadConfiguredRulePacks();

  const result = scrub({
    content: text,
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    options: {
      disabledDetectors,
      enabledDetectors,
      ...(options.strictName !== undefined ? { strictNameDetector: options.strictName } : {}),
      ...(codeTellTerms !== undefined ? { codeTellTerms } : {}),
      ...(urlAllowlist.length > 0 ? { urlAllowlist } : {}),
      customDetectors: rulePackDetectors,
    },
  });

  return result;
}

function pluralize(word: string, count: number): string {
  if (count === 1) return word;
  if (/(s|x|z|ch|sh)$/i.test(word)) return `${word}es`;
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

export function formatScrubSummary(stats: ScrubStats): string {
  const noun = stats.totalEntities === 1 ? 'entity' : 'entities';
  if (stats.totalEntities === 0) {
    return `Scrubbed: 0 ${noun}`;
  }

  const breakdown = Object.entries(stats.byCategory)
    .map(([category, count]) => `${count} ${pluralize(category, count)}`)
    .join(', ');

  return `Scrubbed: ${stats.totalEntities} ${noun} (${breakdown})`;
}

export function setupScrubCommand(program: Command) {
  program
    .command('scrub')
    .description('Scrub a file or stdin')
    .argument('[file]', 'File to scrub. If omitted, reads from stdin.')
    .option('--session-id <id>', 'Resume or target a specific session')
    .option('--disable <detectors>', 'Comma-separated list of detector names to skip')
    .option(
      '--enable <detectors>',
      'Comma-separated list of off-by-default detectors to enable (e.g., NameDetector)',
    )
    .option(
      '--strict-name',
      'Enable strict allowlisting for NameDetector to reduce false positives',
    )
    .option(
      '--code-tell-terms <terms>',
      'Comma-separated list of private identifiers to detect (enables CodeTellDetector)',
    )
    .option(
      '--url-allowlist <hosts>',
      'Comma-separated list of hostnames to pass-through in URLs (subdomains are implicitly allowed)',
    )
    .option('-q, --quiet', 'Suppress the scrub summary printed to stderr')
    .action(async (file, options) => {
      let input = '';

      if (file) {
        try {
          input = readFileSync(file, 'utf8');
        } catch (err: unknown) {
          console.error(`Error reading file: ${(err as Error).message}`);
          process.exit(1);
          return;
        }
      } else {
        // Read from stdin
        try {
          input = readFileSync(0, 'utf-8');
        } catch {
          console.error('No input provided.');
          process.exit(1);
          return;
        }
      }

      if (!input) {
        process.exit(0);
        return;
      }

      // Pull the encryption key up-front when we'll need to write a session.
      // We resolve before reading the file so a wrong key fails fast without
      // leaking the original sensitive content via the scrubbed output.
      const config = loadConfig();
      const sessionIsEncrypted =
        Boolean(config.encryptionEnabled) ||
        (typeof options.sessionId === 'string' && options.sessionId.length > 0
          ? isSessionEncrypted(options.sessionId)
          : false);
      if (sessionIsEncrypted) {
        await resolveEncryptionKeyOrExit();
      }

      const result = await handleScrub(input, options);

      // Print scrubbed content to stdout
      process.stdout.write(result.scrubbedContent as string);

      // Print session ID to stderr
      if (result.scrubbedContent !== input) {
        console.error(`Session ID: ${result.sessionId}`);
      }

      if (!options.quiet) {
        console.error(formatScrubSummary(result.stats));
      }
    });
}
