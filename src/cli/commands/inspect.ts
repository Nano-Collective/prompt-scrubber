import * as crypto from 'node:crypto';
import type { Command } from 'commander';
import { loadConfig } from '../../core/config.js';
import { loadConfiguredRulePacks } from '../../core/rule-packs.js';
import { getActiveDetectors, runDetectors } from '../../core/scrub.js';
import { SessionManager } from '../../session/session-manager.js';
import type { Finding, ScoredFinding } from '../../types/index.js';
import { addDetectorOptions, readInput } from '../io.js';
import { resolveLocale, warnIfLocaleUnused } from '../locale.js';
import { parseConfidence } from '../options.js';
import { sanitizeLine } from '../sanitize.js';

export async function handleInspect(
  text: string,
  options: {
    disable?: string;
    enable?: string;
    strictName?: boolean;
    codeTellTerms?: string;
    urlAllowlist?: string;
    locale?: string;
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
  const locale = resolveLocale(options.locale, config.locale);
  // An explicit flag overrides the configured floor; both default to 0.
  const minConfidence = options.minConfidence ?? config.minConfidence ?? 0;

  const { detectors: rulePackDetectors } = await loadConfiguredRulePacks();

  warnIfLocaleUnused(locale, rulePackDetectors);

  const detectors = getActiveDetectors({
    disabledDetectors,
    enabledDetectors,
    ...(options.strictName !== undefined ? { strictNameDetector: options.strictName } : {}),
    ...(codeTellTerms !== undefined ? { codeTellTerms } : {}),
    ...(urlAllowlist.length > 0 ? { urlAllowlist } : {}),
    ...(locale ? { locale } : {}),
    customDetectors: rulePackDetectors,
  });

  // The effective threshold travels with the result so the caller can name it
  // when reporting what it dropped.
  return { ...runDetectors(text, detectors, minConfidence), minConfidence };
}

export function simulateScrub(text: string, findings: Finding[]): string {
  const session = new SessionManager(undefined, {});
  let scrubbed = text;

  for (const finding of [...findings].reverse()) {
    const placeholder = session.createPlaceholder(finding.placeholderPrefix, finding.value);
    scrubbed = scrubbed.slice(0, finding.span[0]) + placeholder + scrubbed.slice(finding.span[1]);
  }

  return scrubbed;
}

export function computeHash(text: string, findings: Finding[]): string {
  return crypto.createHash('sha256').update(simulateScrub(text, findings)).digest('hex');
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
    const suppressedSection = formatSuppressedSection(suppressed, minConfidence);
    // The blank-line separator before "No session written" only belongs when
    // there is a section above it to separate from — an unconditional `\n`
    // here would add a line main never printed when nothing was suppressed.
    const separator = suppressedSection ? '\n' : '';
    return `No sensitive entities detected.\n${suppressedSection}${separator}No session written.\nHash: ${hash}\n`;
  }

  let output = 'Detected entities:\n';

  const session = new SessionManager(undefined, {});
  const placeholders = findings.map(() => '');
  for (let i = findings.length - 1; i >= 0; i--) {
    const finding = findings[i]!;
    placeholders[i] = session.createPlaceholder(finding.placeholderPrefix, finding.value);
  }

  for (let i = 0; i < findings.length; i++) {
    const finding = findings[i]!;
    const placeholder = placeholders[i]!;

    // The score is what a `--min-confidence` threshold is compared against, so it
    // is shown for every entity rather than only when the flag is in play.
    const score = finding.confidence.toFixed(2);

    // Format: [Category] value -> Placeholder (chars start-end, confidence method)
    const catStr = `[${finding.category}]`.padEnd(10);
    // Truncate very long values for display
    const raw = sanitizeLine(finding.value);
    const valDisp = raw.length > 30 ? `${raw.slice(0, 27)}...` : raw;
    const valStr = valDisp.padEnd(32);

    output += `  ${catStr} ${valStr} → ${placeholder.padEnd(10)} (chars ${finding.span[0]}-${finding.span[1]}, confidence ${score} ${finding.method})\n`;
  }

  output += formatSuppressedSection(suppressed, minConfidence);
  output += `\nNo session written.\nHash: ${hash}\n`;
  return output;
}

export function setupInspectCommand(program: Command) {
  addDetectorOptions(
    program
      .command('inspect')
      .description('Show detected entities without scrubbing')
      .argument('[file]', 'File to inspect. If omitted, reads from stdin.'),
  )
    .option(
      '--min-confidence <value>',
      'Discard findings scored below this confidence (0-1)',
      parseConfidence,
    )
    .option(
      '--locale <locale>',
      'BCP-47 locale (e.g. de-DE) enabling detectors scoped to that locale',
    )
    .option('--hash', 'Print only the SHA-256 hash of the scrubbed output')
    .action(async (file, options) => {
      const input = readInput(file);
      if (input === undefined) return;
      if (!input) {
        process.exit(0);
        return;
      }

      let findings: ScoredFinding[];
      let suppressed: ScoredFinding[];
      let minConfidence: number;
      try {
        ({ findings, suppressed, minConfidence } = await handleInspect(input, options));
      } catch (err: unknown) {
        console.error((err as Error).message);
        process.exit(1);
        return;
      }

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
