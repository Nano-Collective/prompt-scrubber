import type { Command } from 'commander';
import { readFileSync } from 'node:fs';
import * as crypto from 'node:crypto';
import { SessionManager } from '../../session/session-manager.js';
import { resolveCollisions } from '../../core/collision-resolver.js';
import { EmailDetector } from '../../detectors/email.js';
import { PhoneDetector } from '../../detectors/phone.js';
import { UrlDetector } from '../../detectors/url.js';
import { PathDetector } from '../../detectors/path.js';
import { SecretDetector } from '../../detectors/secret.js';
import type { Detector, Finding } from '../../types/index.js';

export function handleInspect(text: string, options: { disable?: string }) {
  const disabledDetectors = new Set(
    (options.disable ?? '').split(',').map((s) => s.trim().toLowerCase().replace('detector', '')),
  );

  const detectors: Detector[] = [
    new SecretDetector(),
    new EmailDetector(),
    new UrlDetector(),
    new PathDetector(),
    new PhoneDetector(),
  ].filter((d) => !disabledDetectors.has(d.name.toLowerCase().replace('detector', '')));

  const allFindings = detectors.flatMap((d) => d.detect(text));
  const findings = resolveCollisions(allFindings);

  return findings;
}

export function computeHash(text: string, findings: Finding[]): string {
  // Use a dummy session to simulate exactly what scrub does (right-to-left replacement)
  const session = new SessionManager();
  let scrubbedContent = text;
  
  for (const finding of [...findings].reverse()) {
    const placeholder = session.createPlaceholder(finding.placeholderPrefix, finding.value);
    scrubbedContent = scrubbedContent.slice(0, finding.span[0]) + placeholder + scrubbedContent.slice(finding.span[1]);
  }
  
  return crypto.createHash('sha256').update(scrubbedContent).digest('hex');
}

export function formatInspectOutput(findings: Finding[], hash: string): string {
  if (findings.length === 0) {
    return `No sensitive entities detected.\nNo session written.\nHash: ${hash}\n`;
  }

  let output = 'Detected entities:\n';

  // We want to simulate the placeholder counts to show what *would* be generated
  const counters: Record<string, number> = {};

  for (const finding of findings) {
    const count = (counters[finding.placeholderPrefix] ?? 0) + 1;
    counters[finding.placeholderPrefix] = count;
    const placeholder = `${finding.placeholderPrefix}_${count}`;

    // Format: [Category] value -> Placeholder (chars start-end)
    const catStr = `[${finding.category}]`.padEnd(10);
    // Truncate very long values for display
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
    .option('--hash', 'Print only the SHA-256 hash of the scrubbed output')
    .action((file, options) => {
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

      const findings = handleInspect(input, options);
      const hash = computeHash(input, findings);

      if (options.hash) {
        process.stdout.write(hash + '\n');
      } else {
        const output = formatInspectOutput(findings, hash);
        process.stdout.write(output);
      }
    });
}
