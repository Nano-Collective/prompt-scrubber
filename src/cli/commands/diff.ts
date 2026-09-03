import { InvalidArgumentError, type Command } from 'commander';
import { addDetectorOptions, readInput } from '../io.js';
import { sanitizeLine } from '../sanitize.js';
import { handleInspect, simulateScrub } from './inspect.js';

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const RESET = '\x1b[0m';
// LCS is n*m; skip the table when the trimmed middle is huge
const LCS_CELL_BUDGET = 250_000;

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

function pairIndexWise(a: string[], b: string[]): Edit[] {
  const n = Math.min(a.length, b.length);
  const out: Edit[] = [];
  for (let i = 0; i < n; i++) {
    if (a[i] === b[i]) out.push({ type: 'eq', line: a[i]! });
    else {
      out.push({ type: 'del', line: a[i]! });
      out.push({ type: 'add', line: b[i]! });
    }
  }
  for (let i = n; i < a.length; i++) out.push({ type: 'del', line: a[i]! });
  for (let i = n; i < b.length; i++) out.push({ type: 'add', line: b[i]! });
  return out;
}

function lcsDiff(a: string[], b: string[]): Edit[] {
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

function diffLines(a: string[], b: string[]): Edit[] {
  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo++;
  let hiA = a.length;
  let hiB = b.length;
  while (hiA > lo && hiB > lo && a[hiA - 1] === b[hiB - 1]) {
    hiA--;
    hiB--;
  }

  const midA = a.slice(lo, hiA);
  const midB = b.slice(lo, hiB);
  const prefix = a.slice(0, lo).map((line) => ({ type: 'eq' as const, line }));
  const suffix = a.slice(hiA).map((line) => ({ type: 'eq' as const, line }));

  let mid: Edit[];
  if (midA.length === midB.length) {
    mid = pairIndexWise(midA, midB);
  } else if (midA.length * midB.length > LCS_CELL_BUDGET) {
    console.error(
      'diff: input too large for a full line comparison; showing an index-wise pairing',
    );
    mid = pairIndexWise(midA, midB);
  } else {
    mid = lcsDiff(midA, midB);
  }

  return [...prefix, ...mid, ...suffix];
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
    if (r > 0) out += '  ...\n';
    const [lo, hi] = ranges[r]!;
    for (let i = lo; i <= hi; i++) {
      const e = edits[i]!;
      const line = sanitizeLine(e.line);
      if (e.type === 'eq') out += `  ${line}\n`;
      else if (e.type === 'del') out += `${paint(`- ${line}`, color ? RED : null)}\n`;
      else out += `${paint(`+ ${line}`, color ? GREEN : null)}\n`;
    }
  }
  return out;
}

function wrap(text: string, width: number): string[] {
  const chars = [...text];
  if (chars.length === 0) return [''];
  const parts: string[] = [];
  for (let i = 0; i < chars.length; i += width) {
    parts.push(chars.slice(i, i + width).join(''));
  }
  return parts;
}

function sideBySideRows(
  left: string,
  right: string,
  col: number,
  leftColor: string | null,
  rightColor: string | null,
): string[] {
  const L = wrap(sanitizeLine(left), col);
  const R = wrap(sanitizeLine(right), col);
  const n = Math.max(L.length, R.length);
  const rows: string[] = [];
  for (let i = 0; i < n; i++) {
    const l = L[i] ?? '';
    const r = R[i] ?? '';
    const lPad = Math.max(0, col - [...l].length);
    const rPad = Math.max(0, col - [...r].length);
    rows.push(
      `${paint(l, leftColor)}${' '.repeat(lPad)} | ${paint(r, rightColor)}${' '.repeat(rPad)}`,
    );
  }
  return rows;
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
    if (r > 0) rows.push(...sideBySideRows('...', '...', col, null, null));
    const slice = edits.slice(ranges[r]![0], ranges[r]![1] + 1);
    let i = 0;
    while (i < slice.length) {
      const e = slice[i]!;
      if (e.type === 'eq') {
        rows.push(...sideBySideRows(e.line, e.line, col, null, null));
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
          ...sideBySideRows(
            left ?? '',
            right ?? '',
            col,
            color && left !== undefined ? RED : null,
            color && right !== undefined ? GREEN : null,
          ),
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

export function parseContext(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new InvalidArgumentError('--context must be a non-negative integer');
  }
  return Number.parseInt(value, 10);
}

export function setupDiffCommand(program: Command) {
  addDetectorOptions(
    program
      .command('diff')
      .description('Show a visual diff of original vs scrubbed text')
      .argument('[file]', 'File to diff. If omitted, reads from stdin.'),
  )
    .option('--side-by-side', 'Two-column original | scrubbed layout')
    .option('--context <n>', 'Unchanged lines around each change', parseContext, 3)
    .option('--no-color', 'Disable ANSI colors')
    .action(async (file, options) => {
      const input = readInput(file);
      if (input === undefined) return;
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
          context: options.context,
        }),
      );
    });
}
