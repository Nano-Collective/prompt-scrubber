import { readFileSync } from 'node:fs';
import type { Command } from 'commander';
import { loadConfig } from '../../core/config.js';

import { CodeTellDetector } from '../../detectors/code-tell.js';
import { loadConfiguredRulePacks } from '../../core/rule-packs.js';
import { getActiveDetectors, scrub } from '../../core/scrub.js';
import { gcSessions } from '../../session/storage.js';
import type { ScrubStats } from '../../types/index.js';
import { parseConfidence } from '../options.js';

export async function handleScrub(
  text: string,
  options: {
    sessionId?: string;
    disable?: string;
    enable?: string;
    strictName?: boolean;
    codeTellTerms?: string;
    urlAllowlist?: string;
    minConfidence?: number;
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
  // An explicit flag overrides the configured floor; both default to 0.
  const minConfidence = options.minConfidence ?? config.minConfidence ?? 0;

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
      ...(minConfidence > 0 ? { minConfidence } : {}),
      customDetectors: rulePackDetectors,
    },
  });

  // The caller needs the *effective* threshold (flag, else config, else 0) to
  // report what it suppressed; only this function knows how it was resolved.
  return { ...result, minConfidence };
}

export function pluralize(word: string, count: number): string {
  if (count === 1) return word;
  if (/(s|x|z|ch|sh)$/i.test(word)) return `${word}es`;
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

function formatBreakdown(byCategory: Record<string, number>): string {
  return Object.entries(byCategory)
    .map(([category, count]) => `${count} ${pluralize(category, count)}`)
    .join(', ');
}

/**
 * "N suppressed below --min-confidence X (breakdown)", or null when the
 * threshold cost nothing. Shared so every surface that can filter reports it
 * the same way.
 */
export function formatSuppressionNotice(stats: ScrubStats, minConfidence: number): string | null {
  const suppressed = stats.suppressed;
  if (!suppressed || suppressed.total === 0) return null;
  return `${suppressed.total} suppressed below --min-confidence ${minConfidence} (${formatBreakdown(suppressed.byCategory)})`;
}

/**
 * The one-line stderr summary.
 *
 * When a threshold dropped something, say so. Without this the output of a
 * filtered run is indistinguishable from "there was nothing there", and
 * `--min-confidence` is aimed squarely at automated workflows where nobody
 * runs `inspect` first — silent under-redaction is the dangerous direction.
 *
 * `minConfidence` is not defaulted: a populated `stats.suppressed` with a
 * forgotten second argument would otherwise print "below --min-confidence 0"
 * instead of failing to compile.
 */
export function formatScrubSummary(stats: ScrubStats, minConfidence: number): string {
  const noun = stats.totalEntities === 1 ? 'entity' : 'entities';
  const scrubbed =
    stats.totalEntities === 0
      ? `Scrubbed: 0 ${noun}`
      : `Scrubbed: ${stats.totalEntities} ${noun} (${formatBreakdown(stats.byCategory)})`;

  const notice = formatSuppressionNotice(stats, minConfidence);
  return notice ? `${scrubbed}; ${notice}` : scrubbed;
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
    .option(
      '--min-confidence <value>',
      'Discard findings scored below this confidence (0-1)',
      parseConfidence,
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

      // Build detector options once and reuse for diagnostics + scrubbing.
      const disabledDetectors = options.disable
        ? options.disable.split(',').map((s: string) => s.trim())
        : [];
      const enabledDetectors = options.enable
        ? options.enable.split(',').map((s: string) => s.trim())
        : [];
      const codeTellTerms = options.codeTellTerms
        ? options.codeTellTerms.split(',').map((s: string) => s.trim())
        : undefined;

      // Warn the user if any configured CodeTell terms were dropped by
      // the per-term length / term-count caps before scrubbing starts.
      for (const detector of getActiveDetectors({
        disabledDetectors,
        enabledDetectors,
        ...(options.strictName !== undefined ? { strictNameDetector: options.strictName } : {}),
        ...(codeTellTerms !== undefined ? { codeTellTerms } : {}),
      })) {
        if (detector instanceof CodeTellDetector) {
          const diag = detector.getDiagnostics();
          if (diag.oversized.length > 0) {
            console.error(
              `Warning: CodeTellDetector dropped ${diag.oversized.length} term(s) longer than 64 chars: ${diag.oversized.map((t) => `"${t.slice(0, 24)}…"`).join(', ')}`,
            );
          }
          if (diag.overflowed.length > 0) {
            console.error(
              `Warning: CodeTellDetector dropped ${diag.overflowed.length} term(s) past the 64-term cap`,
            );
          }
        }
      }

      const result = await handleScrub(input, options);

      // Print scrubbed content to stdout
      process.stdout.write(result.scrubbedContent as string);

      // Print session ID to stderr
      if (result.scrubbedContent !== input) {
        console.error(`Session ID: ${result.sessionId}`);
      }

      if (!options.quiet) {
        console.error(formatScrubSummary(result.stats, result.minConfidence));
      } else {
        // --quiet is exactly the automated-workflow path --min-confidence
        // targets, so it must not be the thing that hides what got dropped.
        const notice = formatSuppressionNotice(result.stats, result.minConfidence);
        if (notice) {
          console.error(notice);
        }
      }
    });
}
