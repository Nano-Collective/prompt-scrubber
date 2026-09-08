import { type Command, InvalidArgumentError } from 'commander';
import { SessionManager } from '../../session/session-manager.js';
import type { Finding } from '../../types/index.js';
import { addDetectorOptions, readInput } from '../io.js';
import { sanitizeLine } from '../sanitize.js';
import { handleInspect, simulateScrub } from './inspect.js';

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const RESET = '\x1b[0m';

type DiffFormatOptions = {
  color?: boolean;
  sideBySide?: boolean;
  context?: number;
  width?: number;
  findings?: Finding[];
};

type Edit = { type: 'eq' | 'del' | 'add'; line: string };

function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function lineIndexAt(text: string, offset: number): number {
  let line = 0;
  const n = Math.min(Math.max(0, offset), text.length);
  for (let i = 0; i < n; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}

function dirtyLines(text: string, spans: Array<[number, number]>): boolean[] {
  const dirty = splitLines(text).map(() => false);
  if (dirty.length === 0) return dirty;
  for (const [start, end] of spans) {
    const from = Math.min(lineIndexAt(text, start), dirty.length - 1);
    const to = Math.min(lineIndexAt(text, Math.max(start, end - 1)), dirty.length - 1);
    for (let i = from; i <= to; i++) dirty[i] = true;
  }
  return dirty;
}

function placeholderSpans(scrubbed: string, findings: Finding[]): Array<[number, number]> {
  const session = new SessionManager(undefined, {});
  const phs: string[] = [];
  for (const finding of [...findings].reverse()) {
    phs.push(session.createPlaceholder(finding.placeholderPrefix, finding.value));
  }
  const spans: Array<[number, number]> = [];
  for (const ph of phs) {
    let from = 0;
    while (from <= scrubbed.length) {
      const idx = scrubbed.indexOf(ph, from);
      if (idx === -1) break;
      spans.push([idx, idx + ph.length]);
      from = idx + ph.length;
    }
  }
  return spans;
}

function alignByFindings(
  a: string[],
  b: string[],
  origDirty: boolean[],
  scrubDirty: boolean[],
): Edit[] {
  const out: Edit[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && !origDirty[i] && !scrubDirty[j] && a[i] === b[j]) {
      out.push({ type: 'eq', line: a[i]! });
      i++;
      j++;
    } else if (i < a.length && origDirty[i]) {
      out.push({ type: 'del', line: a[i]! });
      i++;
    } else if (j < b.length && scrubDirty[j]) {
      out.push({ type: 'add', line: b[j]! });
      j++;
    } else if (i < a.length && j < b.length) {
      out.push({ type: 'del', line: a[i]! });
      out.push({ type: 'add', line: b[j]! });
      i++;
      j++;
    } else if (i < a.length) {
      out.push({ type: 'del', line: a[i]! });
      i++;
    } else {
      out.push({ type: 'add', line: b[j]! });
      j++;
    }
  }
  return out;
}

// Scrub never inserts lines, so equal-length middles can be paired by index.
// Unequal middles dump as all dels then all adds — not a general-purpose diff.
function diffLines(a: string[], b: string[]): Edit[] {
  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo++;
  let hiA = a.length;
  let hiB = b.length;
  while (hiA > lo && hiB > lo && a[hiA - 1] === b[hiB - 1]) {
    hiA--;
    hiB--;
  }

  const out: Edit[] = [];
  for (let i = 0; i < lo; i++) out.push({ type: 'eq', line: a[i]! });
  if (hiA - lo === hiB - lo) {
    for (let i = lo; i < hiA; i++) {
      if (a[i] === b[i]) out.push({ type: 'eq', line: a[i]! });
      else {
        out.push({ type: 'del', line: a[i]! });
        out.push({ type: 'add', line: b[i]! });
      }
    }
  } else {
    for (let i = lo; i < hiA; i++) out.push({ type: 'del', line: a[i]! });
    for (let i = lo; i < hiB; i++) out.push({ type: 'add', line: b[i]! });
  }
  for (let i = hiA; i < a.length; i++) out.push({ type: 'eq', line: a[i]! });
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

function charWidth(cp: number): number {
  if (cp < 32 || cp === 127) return 0;
  if (cp < 127) return 1;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2329 && cp <= 0x232a) ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

function displayWidth(text: string): number {
  let w = 0;
  for (const ch of text) w += charWidth(ch.codePointAt(0)!);
  return w;
}

function wrap(text: string, width: number): string[] {
  const col = Math.max(1, width);
  const parts: string[] = [];
  let cur = '';
  let w = 0;
  for (const ch of text) {
    const cw = charWidth(ch.codePointAt(0)!);
    if (cur && w + cw > col) {
      parts.push(cur);
      cur = '';
      w = 0;
    }
    cur += ch;
    w += cw;
  }
  if (cur || parts.length === 0) parts.push(cur);
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
    const lPad = Math.max(0, col - displayWidth(l));
    rows.push(`${paint(l, leftColor)}${' '.repeat(lPad)} | ${paint(r, rightColor)}`);
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

export function shouldColor(
  colorFlag: boolean | undefined,
  isTTY: boolean,
  noColorEnv: string | undefined,
): boolean {
  return colorFlag !== false && isTTY && !noColorEnv;
}

export function formatDiff(
  original: string,
  scrubbed: string,
  options: DiffFormatOptions = {},
): string {
  const color = options.color === true;
  const context = options.context ?? 3;
  const a = splitLines(original);
  const b = splitLines(scrubbed);
  const findings = options.findings;
  const edits =
    findings && findings.length > 0
      ? alignByFindings(
          a,
          b,
          dirtyLines(
            original,
            findings.map((f) => f.span),
          ),
          dirtyLines(scrubbed, placeholderSpans(scrubbed, findings)),
        )
      : diffLines(a, b);
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
      const useColor = shouldColor(
        options.color,
        Boolean(process.stdout.isTTY),
        process.env.NO_COLOR,
      );

      process.stdout.write(
        formatDiff(input, scrubbed, {
          color: useColor,
          sideBySide: Boolean(options.sideBySide),
          context: options.context,
          findings,
        }),
      );
    });
}
