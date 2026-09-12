import { InvalidArgumentError } from 'commander';

/**
 * Commander option parser for `--min-confidence`. Rejecting out-of-range values
 * here means the CLI exits with a clear message instead of silently scrubbing
 * more (or less) than the user asked for.
 *
 * Shared by every command that takes the flag (`scrub`, `inspect`, `watch`) so
 * none of them has to reach into another command's module for it.
 */
export function parseConfidence(value: string): number {
  // Number(), not Number.parseFloat(): parseFloat stops at the first invalid
  // character, so `0.9zzz` would quietly become 0.9 — exactly the silent
  // reinterpretation this function exists to prevent. Number() rejects the
  // whole string outright, and still accepts `0`, `1`, `.85` and `9e-1`.
  // Number('') is 0, so an empty value is rejected explicitly.
  const trimmed = value.trim();
  const parsed = Number(trimmed);
  if (trimmed === '' || Number.isNaN(parsed) || parsed < 0 || parsed > 1) {
    throw new InvalidArgumentError('Expected a number between 0 and 1.');
  }
  return parsed;
}
