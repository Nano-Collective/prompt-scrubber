import { readFileSync } from 'node:fs';
import type { Command } from 'commander';

export function readInput(file?: string): string | undefined {
  if (file) {
    try {
      return readFileSync(file, 'utf8');
    } catch (err: unknown) {
      console.error(`Error reading file: ${(err as Error).message}`);
      process.exit(1);
      return undefined;
    }
  }
  try {
    return readFileSync(0, 'utf-8');
  } catch {
    console.error('No input provided.');
    process.exit(1);
    return undefined;
  }
}

export function addDetectorOptions(cmd: Command): Command {
  return cmd
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
    );
}
