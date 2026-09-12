import * as crypto from 'node:crypto';
import type { Command } from 'commander';
import { loadConfig } from '../../core/config.js';
import { loadConfiguredRulePacks } from '../../core/rule-packs.js';
import { getActiveDetectors, runDetectors } from '../../core/scrub.js';
import { SessionManager } from '../../session/session-manager.js';
import type { ScoredFinding } from '../../types/index.js';
import { emitJson } from '../output.js';
import { addDetectorOptions, readInput } from '../io.js';
import { sanitizeLine } from '../sanitize.js';
import { parseConfidence } from '../options.js';

interface InspectJsonEntity {
  category: string;
  value: string;
  placeholder: string;
  span: [number, number];
  confidence: number;
  method: string;
}

interface InspectJsonSuppressed {
  category: string;
  value: string;
  span: [number, number];
  confidence: number;
  method: string;
}

interface InspectJsonOutput {
  entities: InspectJsonEntity[];

  /** Findings the --min-confidence threshold discarded — still in the clear. */
  suppressed: InspectJsonSuppressed[];

  hash: string;
}

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

export function simulateScrub(text: string, findings: ScoredFinding[]): string {
  const session = new SessionManager(undefined, {});
  let scrubbed = text;

  // Process findings in reverse order (right-to-left) as scrub does
  for (const finding of [...findings].reverse()) {
    const placeholder = session.createPlaceholder(finding.placeholderPrefix, finding.value);
    scrubbed = scrubbed.slice(0, finding.span[0]) + placeholder + scrubbed.slice(finding.span[1]);
  }

  return scrubbed;
}

export function computeHash(text: string, findings: ScoredFinding[]): string {
  return crypto.createHash('sha256').update(simulateScrub(text, findings)).digest('hex');
}

/**
 * Placeholder per finding, in the same order the findings are reported in.
 *
 * Placeholders are minted right-to-left (matching scrub's replacement order)
 * so the numbering matches what an actual scrub run would produce.
 */
function assignPlaceholders(findings: ScoredFinding[]): string[] {
  const session = new SessionManager(undefined, {});
  const placeholders = findings.map(() => '');
  for (let i = findings.length - 1; i >= 0; i--) {
    const finding = findings[i]!;
    placeholders[i] = session.createPlaceholder(finding.placeholderPrefix, finding.value);
  }
  return placeholders;
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

  const placeholders = assignPlaceholders(findings);

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

function toInspectJson(
  findings: ScoredFinding[],
  hash: string,
  suppressed: ScoredFinding[] = [],
): InspectJsonOutput {
  const placeholders = assignPlaceholders(findings);

  return {
    entities: findings.map((finding, i) => ({
      category: finding.category,
      value: sanitizeLine(finding.value),
      placeholder: placeholders[i]!,
      span: finding.span,
      confidence: finding.confidence,
      method: finding.method,
    })),
    // The same guarantee the text format gives: a filtered JSON report must not
    // read as "nothing sensitive" while the dropped findings are still in the clear.
    suppressed: suppressed.map((finding) => ({
      category: finding.category,
      value: sanitizeLine(finding.value),
      span: finding.span,
      confidence: finding.confidence,
      method: finding.method,
    })),
    hash,
  };
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
    .option('--hash', 'Print only the SHA-256 hash of the scrubbed output')
    .option('--json', 'Output a structured JSON object instead of plain text')
    .action(async (file, options) => {
      const input = readInput(file, options.json);
      if (input === undefined) return;
      if (!input) {
        if (options.json) {
          emitJson(toInspectJson([], computeHash('', [])));
        }
        process.exit(0);
        return;
      }

      const { findings, suppressed, minConfidence } = await handleInspect(input, options);
      const hash = computeHash(input, findings);

      if (options.json) {
        emitJson(toInspectJson(findings, hash, suppressed));
      } else if (options.hash) {
        // --hash stays the scripting-stable surface: only the scrubbed text
        // feeds it, so the suppression report never perturbs it.
        process.stdout.write(`${hash}\n`);
      } else {
        process.stdout.write(formatInspectOutput(findings, hash, suppressed, minConfidence));
      }
    });
}
