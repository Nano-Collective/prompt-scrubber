import * as crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Command } from 'commander';
import { resolveCollisions } from '../../core/collision-resolver.js';
import { loadConfig } from '../../core/config.js';
import { loadConfiguredRulePacks } from '../../core/rule-packs.js';
import { getActiveDetectors } from '../../core/scrub.js';
import { SessionManager } from '../../session/session-manager.js';
import type { Finding } from '../../types/index.js';
import { emitError } from '../output.js';

export interface InspectJsonOutput {
  entities: Array<{
    category: string;
    value: string;
    placeholder: string;
    span: [number, number];
  }>;

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

  const { detectors: rulePackDetectors } = await loadConfiguredRulePacks();

  const detectors = getActiveDetectors({
    disabledDetectors,
    enabledDetectors,
    ...(options.strictName !== undefined ? { strictNameDetector: options.strictName } : {}),
    ...(codeTellTerms !== undefined ? { codeTellTerms } : {}),
    ...(urlAllowlist.length > 0 ? { urlAllowlist } : {}),
    customDetectors: rulePackDetectors,
  });

  const allFindings = detectors.flatMap((d) => d.detect(text));
  const findings = resolveCollisions(allFindings);

  return findings;
}

export function computeHash(
  text: string,
  findings: Finding[],
): {
  hash: string;
  placeholderMap: Map<number, string>; // Map from finding index to placeholder
} {
  const session = new SessionManager();
  const placeholderMap = new Map<number, string>();
  let scrubbedContent = text;

  // Process findings in reverse order (right-to-left) as scrub does
  for (let i = findings.length - 1; i >= 0; i--) {
    const finding = findings[i];

    if (!finding) continue;

    const placeholder = session.createPlaceholder(finding.placeholderPrefix, finding.value);

    placeholderMap.set(i, placeholder);

    scrubbedContent =
      scrubbedContent.slice(0, finding.span[0]) +
      placeholder +
      scrubbedContent.slice(finding.span[1]);
  }

  const hash = crypto.createHash('sha256').update(scrubbedContent).digest('hex');

  return { hash, placeholderMap };
}

export function toInspectJson(
  findings: Finding[],
  hash: string,
  placeholderMap: Map<number, string>,
): InspectJsonOutput {
  const entities = findings.map((finding, index) => {
    const placeholder = placeholderMap.get(index) || '«UNKNOWN»';

    return {
      category: finding.category,
      value: finding.value,
      placeholder,
      span: finding.span,
    };
  });

  return {
    entities,
    hash,
  };
}

export function formatInspectOutput(
  findings: Finding[],
  hash: string,
  placeholderMap: Map<number, string>,
): string {
  if (findings.length === 0) {
    return `No sensitive entities detected.\nNo session written.\nHash: ${hash}\n`;
  }

  let output = 'Detected entities:\n';

  for (let i = 0; i < findings.length; i++) {
    const finding = findings[i];

    if (!finding) continue;

    const placeholder = placeholderMap.get(i) || '«UNKNOWN»';

    const catStr = `[${finding.category}]`.padEnd(10);

    const valDisp = finding.value.length > 30 ? `${finding.value.slice(0, 27)}...` : finding.value;

    const valStr = valDisp.padEnd(32);

    output += `  ${catStr} ${valStr} → ${placeholder.padEnd(10)} (chars ${finding.span[0]}-${finding.span[1]})\n`;
  }

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
    .option('--hash', 'Print only the SHA-256 hash of the scrubbed output')
    .option('--json', 'Output a structured JSON object instead of plain text')
    .action(async (file, options) => {
      let input = '';

      if (file) {
        try {
          input = readFileSync(file, 'utf8');
        } catch (err: unknown) {
          const message = `Error reading file: ${(err as Error).message}`;
          emitError(message, options.json);
          process.exit(1);
          return;
        }
      } else {
        try {
          input = readFileSync(0, 'utf-8');
        } catch {
          const message = 'No input provided.';
          emitError(message, options.json);
          process.exit(1);
          return;
        }
      }

      if (!input) {
        if (options.json) {
          const output = toInspectJson(
            [],
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
            new Map(),
          );

          process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
        }

        process.exit(0);
        return;
      }

      const findings = await handleInspect(input, options);

      const hashResult = computeHash(input, findings);

      if (options.json) {
        const output = toInspectJson(findings, hashResult.hash, hashResult.placeholderMap);

        process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
      } else if (options.hash) {
        process.stdout.write(`${hashResult.hash}\n`);
      } else {
        const output = formatInspectOutput(findings, hashResult.hash, hashResult.placeholderMap);

        process.stdout.write(output);
      }
    });
}
