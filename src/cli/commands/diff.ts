import { readFileSync } from 'node:fs';
import type { Command } from 'commander';
import { handleInspect, simulateScrub } from './inspect.js';

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const RESET = '\x1b[0m';

type DiffFormatOptions = {
  color?: boolean;
  sideBySide?: boolean;
  context?: number;
  width?: number;
};

type Edit = { type: 'eq' | 'del' | 'add'; line: string };

function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function diffLines(a: string[], b: string[]): Edit[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const out: Edit[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: 'eq', line: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ type: 'del', line: a[i]! });
      i++;
    } else {
      out.push({ type: 'add', line: b[j]! });
      j++;
    }
  }
  while (i < n) {
    out.push({ type: 'del', line: a[i]! });
    i++;
  }
  while (j < m) {
    out.push({ type: 'add', line: b[j]! });
    j++;
  }
  return out;
}

function changeRanges(edits: Edit[], context: number): Array<[number, number]> {
  const n = edits.length;
  const keep = edits.map((e) => e.type !== 'eq');
  if (!keep.some(Boolean)) return [];

  const ctx = Math.max(0, context);
  const show = Array<boolean>(n).fill(false);
  for (let i = 0; i < n; i++) {
    if (!keep[i]) continue;
    const lo = Math.max(0, i - ctx);
    const hi = Math.min(n - 1, i + ctx);
    show.fill(true, lo, hi + 1);
  }

  const ranges: Array<[number, number]> = [];
  let start = -1;
  for (let i = 0; i < n; i++) {
    if (show[i]) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      ranges.push([start, i - 1]);
      start = -1;
    }
  }
  if (start >= 0) ranges.push([start, n - 1]);
  return ranges;
}

function paint(text: string, color: string | null): string {
  return color ? `${color}${text}${RESET}` : text;
}

function formatUnified(edits: Edit[], ranges: Array<[number, number]>, color: boolean): string {
  let out = '';
  for (let r = 0; r < ranges.length; r++) {
    if (r > 0) out += '...\n';
    const [lo, hi] = ranges[r]!;
    for (let i = lo; i <= hi; i++) {
      const e = edits[i]!;
      if (e.type === 'eq') out += `  ${e.line}\n`;
      else if (e.type === 'del') out += `${paint(`- ${e.line}`, color ? RED : null)}\n`;
      else out += `${paint(`+ ${e.line}`, color ? GREEN : null)}\n`;
    }
  }
  return out;
}

function cell(text: string, width: number, color: string | null): string {
  const raw = text.length > width ? `${text.slice(0, Math.max(0, width - 3))}...` : text;
  return paint(raw, color) + ' '.repeat(Math.max(0, width - raw.length));
}

function formatSideBySide(
  edits: Edit[],
  ranges: Array<[number, number]>,
  color: boolean,
  width: number,
): string {
  const col = Math.max(8, Math.floor((width - 3) / 2));
  const rows: string[] = [];

  for (let r = 0; r < ranges.length; r++) {
    if (r > 0) rows.push(`${cell('...', col, null)} | ${cell('...', col, null)}`);
    const slice = edits.slice(ranges[r]![0], ranges[r]![1] + 1);
    let i = 0;
    while (i < slice.length) {
      const e = slice[i]!;
      if (e.type === 'eq') {
        rows.push(`${cell(e.line, col, null)} | ${cell(e.line, col, null)}`);
        i++;
        continue;
      }
      const dels: string[] = [];
      const adds: string[] = [];
      while (i < slice.length && slice[i]!.type !== 'eq') {
        if (slice[i]!.type === 'del') dels.push(slice[i]!.line);
        else adds.push(slice[i]!.line);
        i++;
      }
      const n = Math.max(dels.length, adds.length);
      for (let k = 0; k < n; k++) {
        const left = dels[k];
        const right = adds[k];
        rows.push(
          `${cell(left ?? '', col, color && left !== undefined ? RED : null)} | ${cell(right ?? '', col, color && right !== undefined ? GREEN : null)}`,
        );
      }
    }
  }

  return `${rows.join('\n')}\n`;
}

export function formatDiff(
  original: string,
  scrubbed: string,
  options: DiffFormatOptions = {},
): string {
  const color = options.color === true;
  const context = options.context ?? 3;
  const edits = diffLines(splitLines(original), splitLines(scrubbed));
  const ranges = changeRanges(edits, context);
  if (ranges.length === 0) return 'No changes.\n';
  if (options.sideBySide) {
    const width = options.width ?? process.stdout.columns ?? 80;
    return formatSideBySide(edits, ranges, color, width);
  }
  return formatUnified(edits, ranges, color);
}

function parseContext(value: unknown): number {
  const n = Number.parseInt(String(value ?? '3'), 10);
  return Number.isFinite(n) && n >= 0 ? n : 3;
}

export function setupDiffCommand(program: Command) {
  program
    .command('diff')
    .description('Show a visual diff of original vs scrubbed text')
    .argument('[file]', 'File to diff. If omitted, reads from stdin.')
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
    .option('--side-by-side', 'Two-column original | scrubbed layout')
    .option('--context <n>', 'Unchanged lines around each change', '3')
    .option('--no-color', 'Disable ANSI colors')
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

      const findings = await handleInspect(input, options);
      const scrubbed = simulateScrub(input, findings);
      const useColor =
        options.color !== false && Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

      process.stdout.write(
        formatDiff(input, scrubbed, {
          color: useColor,
          sideBySide: Boolean(options.sideBySide),
          context: parseContext(options.context),
        }),
      );
    });
}
