import * as crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Command } from 'commander';
import { loadConfig } from '../../core/config.js';
import { loadConfiguredRulePacks } from '../../core/rule-packs.js';
import { getActiveDetectors, runDetectors } from '../../core/scrub.js';
import { SessionManager } from '../../session/session-manager.js';
import type { Finding, ScoredFinding } from '../../types/index.js';
import { parseConfidence } from './scrub.js';

export async function handleInspect(
  text: string,
  options: {
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
  const urlAllowlist = Array.from(new Set([...(config.urlAllowlist || []), ...cliUrlAllowlist]));
  // An explicit flag overrides the configured floor; both default to 0.
  const minConfidence = options.minConfidence ?? config.minConfidence ?? 0;

  const { detectors: rulePackDetectors } = await loadConfiguredRulePacks();

  const detectors = getActiveDetectors({
    disabledDetectors,
    enabledDetectors,
    ...(options.strictName !== undefined ? { strictNameDetector: options.strictName } : {}),
    ...(codeTellTerms !== undefined ? { codeTellTerms } : {}),
    ...(urlAllowlist.length > 0 ? { urlAllowlist } : {}),
    customDetectors: rulePackDetectors,
  });

  // The effective threshold travels with the result so the caller can name it
  // when reporting what it dropped.
  return { ...runDetectors(text, detectors, minConfidence), minConfidence };
}

export function computeHash(text: string, findings: Finding[]): string {
  // Use a dummy session to simulate exactly what scrub does (right-to-left replacement)
  const session = new SessionManager();
  let scrubbedContent = text;

  for (const finding of [...findings].reverse()) {
    const placeholder = session.createPlaceholder(finding.placeholderPrefix, finding.value);
    scrubbedContent =
      scrubbedContent.slice(0, finding.span[0]) +
      placeholder +
      scrubbedContent.slice(finding.span[1]);
  }

  return crypto.createHash('sha256').update(scrubbedContent).digest('hex');
}

/**
 * The block listing what a `--min-confidence` threshold discarded.
 *
 * Shown even when nothing survived: an empty "no entities detected" report on a
 * filtered run is exactly the message that would mislead someone into sending
 * a prompt that still has a phone number in it.
 */
function formatSuppressedSection(suppressed: ScoredFinding[], minConfidence: number): string {
  if (suppressed.length === 0) return '';

  let output = `\nSuppressed below --min-confidence ${minConfidence}:\n`;
  for (const finding of suppressed) {
    const catStr = `[${finding.category}]`.padEnd(10);
    const valDisp = finding.value.length > 30 ? `${finding.value.slice(0, 27)}...` : finding.value;
    const valStr = valDisp.padEnd(32);
    const score = finding.confidence.toFixed(2);
    output += `  ${catStr} ${valStr}   left in the clear (chars ${finding.span[0]}-${finding.span[1]}, confidence ${score} ${finding.method})\n`;
  }
  return output;
}

export function formatInspectOutput(
  findings: ScoredFinding[],
  hash: string,
  suppressed: ScoredFinding[] = [],
  minConfidence = 0,
): string {
  if (findings.length === 0) {
    return `No sensitive entities detected.\n${formatSuppressedSection(suppressed, minConfidence)}\nNo session written.\nHash: ${hash}\n`;
  }

  let output = 'Detected entities:\n';

  // We want to simulate the placeholder counts to show what *would* be generated
  const counters: Record<string, number> = {};

  for (const finding of findings) {
    const count = (counters[finding.placeholderPrefix] ?? 0) + 1;
    counters[finding.placeholderPrefix] = count;
    const placeholder = `«${finding.placeholderPrefix}_${count}»`;

    // The score is what a `--min-confidence` threshold is compared against, so it
    // is shown for every entity rather than only when the flag is in play.
    const score = finding.confidence.toFixed(2);

    // Format: [Category] value -> Placeholder (chars start-end, confidence method)
    const catStr = `[${finding.category}]`.padEnd(10);
    // Truncate very long values for display
    const valDisp = finding.value.length > 30 ? `${finding.value.slice(0, 27)}...` : finding.value;
    const valStr = valDisp.padEnd(32);

    output += `  ${catStr} ${valStr} → ${placeholder.padEnd(10)} (chars ${finding.span[0]}-${finding.span[1]}, confidence ${score} ${finding.method})\n`;
  }

  output += formatSuppressedSection(suppressed, minConfidence);
  output += `\nNo session written.\nHash: ${hash}\n`;
  return output;
}

export function setupInspectCommand(program: Command) {
  program
    .command('inspect')
    .description('Show detected entities without scrubbing')
    .argument('[file]', 'File to inspect. If omitted, reads from stdin.')
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
    .option('--hash', 'Print only the SHA-256 hash of the scrubbed output')
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

      const { findings, suppressed, minConfidence } = await handleInspect(input, options);
      const hash = computeHash(input, findings);

      if (options.hash) {
        // --hash stays the scripting-stable surface: only the scrubbed text
        // feeds it, so the suppression report never perturbs it.
        process.stdout.write(`${hash}\n`);
      } else {
        const output = formatInspectOutput(findings, hash, suppressed, minConfidence);
        process.stdout.write(output);
      }
    });
}
