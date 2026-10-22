import type { Finding } from '../types/index.js';

// Priority table: lower number = higher priority (wins collisions)
const DETECTOR_PRIORITY: Record<string, number> = {
  SecretDetector: 1,
  CreditCardDetector: 2,
  IbanDetector: 3,
  SsnDetector: 4,
  EmailDetector: 5,
  UrlDetector: 6,
  PathDetector: 7,
  IpAddressDetector: 8,
  PhoneDetector: 9,
  AddressDetector: 10,
  NameDetector: 11,
  CodeTellDetector: 12,
};

/**
 * A finding carrying the extra bookkeeping collision resolution needs.
 *
 * `localeScoped` is set by `runDetectors` for every finding produced by a
 * detector that declares `locales`. It is an internal marker rather than part
 * of the public `Finding` shape, but it travels on the finding itself so that
 * mapping or cloning findings between detection and resolution cannot silently
 * drop it.
 */
export interface ResolvableFinding extends Finding {
  localeScoped?: boolean;
}

function priorityOf(finding: Finding): number {
  // category maps to detector name (e.g. "Email" → "EmailDetector")
  return DETECTOR_PRIORITY[`${finding.category}Detector`] ?? 99;
}

/**
 * True when `outer` redacts every character `inner` does (and possibly more).
 * The locale tie-break below only prefers a locale-scoped finding when it
 * covers the finding it would displace — on a partial overlap (as opposed to
 * strict containment), preferring the locale finding would still leave part
 * of `inner`'s span in the clear, so it must not win outright there either.
 */
function covers(outer: Finding, inner: Finding): boolean {
  return outer.span[0] <= inner.span[0] && outer.span[1] >= inner.span[1];
}

/** Decides which of two overlapping findings survives. */
function candidateWins(candidate: ResolvableFinding, existing: ResolvableFinding): boolean {
  const candidatePriority = priorityOf(candidate);
  const existingPriority = priorityOf(existing);

  if (candidatePriority !== existingPriority) {
    return candidatePriority < existingPriority;
  }

  // Same category — not just same priority bucket, which is what the check
  // above actually compares: two different categories that both fall through
  // to the ?? 99 default (e.g. a locale-scoped "Cpf" finding and an unrelated
  // custom "Ticket" finding) must not enter the locale tie-break together.
  //
  // A locale-scoped finding replaces the English-shaped one, so a locale pack
  // can correct a built-in match instead of losing to it. It is never allowed
  // to shrink the redacted span — preferring a finding that covers less text
  // than the one it would displace would leak text that used to be replaced,
  // whether that finding sits strictly inside the other or only partially
  // overlaps it.
  if (
    candidate.category === existing.category &&
    Boolean(candidate.localeScoped) !== Boolean(existing.localeScoped)
  ) {
    const preferred = candidate.localeScoped ? candidate : existing;
    const other = candidate.localeScoped ? existing : candidate;
    if (covers(preferred, other)) {
      return preferred === candidate;
    }
    // Partial, non-containing overlap: the locale finding does not cover the
    // finding it would displace, so it must lose outright rather than fall to
    // the length tie-break below - a longer locale value could otherwise win
    // and still expose the part of the other finding's span it does not cover.
    return !candidate.localeScoped;
  }

  return candidate.value.length > existing.value.length;
}

// A narrowed fragment is weaker evidence than the match it came from: it is
// the remainder of a span another, higher-priority finding has already
// contradicted, not a full match for whatever pattern gave the original its
// score. Attenuated by this factor so a filter downstream can tell the two
// apart, rather than the fragment inheriting the original's confidence as if
// nothing had happened to it.
const NARROWED_CONFIDENCE_FACTOR = 0.8;

/**
 * Splits `loser` into the parts `winner` does not cover, so an over-broad
 * finding is narrowed rather than dropped (dropping it would emit whatever it
 * over-matched in cleartext). Surrounding whitespace is trimmed off each part.
 *
 * Nothing is kept when:
 * - both findings share a category, since they are rival readings of one entity
 *   and the winner's span is the authoritative one; or
 * - the loser's value does not map 1:1 onto its span (e.g. a normalised value),
 *   since the text a part covers is then not recoverable here.
 *
 * A returned part's `confidence` (when the loser has one) is attenuated by
 * `NARROWED_CONFIDENCE_FACTOR` rather than copied unchanged — see that
 * constant's comment.
 */
function subtract<T extends Finding>(loser: T, winner: T): T[] {
  if (loser.category === winner.category || loser.value.length !== loser.span[1] - loser.span[0]) {
    return [];
  }

  const bounds: [number, number][] = [
    [loser.span[0], Math.min(loser.span[1], winner.span[0])],
    [Math.max(loser.span[0], winner.span[1]), loser.span[1]],
  ];

  const parts: T[] = [];
  for (const [start, end] of bounds) {
    const slice = loser.value.slice(start - loser.span[0], end - loser.span[0]);
    const value = slice.trim();
    if (value.length === 0) {
      continue;
    }
    const offset = start + slice.indexOf(value);
    const part: T = { ...loser, span: [offset, offset + value.length], value };
    // Only overwrite when the loser actually has a score, so a fragment of a
    // Finding without one does not gain a `confidence` key it never had.
    if (loser.confidence !== undefined) {
      part.confidence = loser.confidence * NARROWED_CONFIDENCE_FACTOR;
    }
    parts.push(part);
  }
  return parts;
}

/**
 * Min-heap of findings ordered by start position, then by insertion order.
 * The insertion tiebreak makes it behave exactly like a stably sorted queue
 * that new entries are appended to.
 */
class FindingQueue<T extends Finding> {
  private readonly heap: { finding: T; seq: number }[] = [];
  private nextSeq = 0;

  get size(): number {
    return this.heap.length;
  }

  push(finding: T): void {
    const heap = this.heap;
    heap.push({ finding, seq: this.nextSeq++ });
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.before(i, parent)) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): T | undefined {
    const heap = this.heap;
    const top = heap[0];
    const last = heap.pop();
    if (top === undefined || last === undefined) return top?.finding;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;
        if (left < heap.length && this.before(left, smallest)) smallest = left;
        if (right < heap.length && this.before(right, smallest)) smallest = right;
        if (smallest === i) break;
        this.swap(i, smallest);
        i = smallest;
      }
    }
    return top.finding;
  }

  private before(a: number, b: number): boolean {
    const x = this.heap[a]!;
    const y = this.heap[b]!;
    return x.finding.span[0] !== y.finding.span[0]
      ? x.finding.span[0] < y.finding.span[0]
      : x.seq < y.seq;
  }

  private swap(a: number, b: number): void {
    const heap = this.heap;
    [heap[a], heap[b]] = [heap[b]!, heap[a]!];
  }
}

/**
 * Index in `accepted` of the leftmost finding that overlaps `candidate`, or -1.
 * `accepted` is sorted by start and pairwise non-overlapping, so its ends are
 * sorted too: the first finding that ends after the candidate starts is the only
 * one that can be leftmost, and it overlaps only if it also starts before the
 * candidate ends.
 */
function firstOverlap(accepted: Finding[], candidate: Finding): number {
  let lo = 0;
  let hi = accepted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (accepted[mid]!.span[1] > candidate.span[0]) hi = mid;
    else lo = mid + 1;
  }
  return lo < accepted.length && accepted[lo]!.span[0] < candidate.span[1] ? lo : -1;
}

/** Insert after every finding that starts at or before `finding`, keeping `accepted` sorted. */
function insertSorted<T extends Finding>(accepted: T[], finding: T): void {
  const last = accepted[accepted.length - 1];
  if (last === undefined || last.span[0] <= finding.span[0]) {
    accepted.push(finding);
    return;
  }
  let lo = 0;
  let hi = accepted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (accepted[mid]!.span[0] <= finding.span[0]) lo = mid + 1;
    else hi = mid;
  }
  accepted.splice(lo, 0, finding);
}

/**
 * Given a flat array of all findings from all detectors, removes overlapping
 * spans so that the result contains only non-overlapping findings.
 *
 * When two findings overlap, the one from the higher-priority detector wins.
 * Within one category a locale-scoped finding takes precedence, but only when
 * it covers the same text as the finding it would displace or more - it never
 * wins by covering less, whether it sits strictly inside the other finding or
 * only partially overlaps it. Remaining ties resolve in favour of the longer
 * span. The loser is kept, narrowed to the part of its span the winner does
 * not cover.
 *
 * Terminates because every overlap either removes a finding outright or
 * replaces one with strictly shorter parts, so the total span length across
 * queue and accepted set strictly decreases each time an overlap is resolved.
 *
 * Runs in O(n log n) for findings that do not overlap, and each overlap costs
 * O(log n) more: candidates come off a heap in start order, and the accepted
 * set is kept sorted so the finding a candidate collides with is found by
 * binary search rather than a scan.
 *
 * Returns findings sorted by start position ascending, guaranteed pairwise
 * non-overlapping - `scrub` relies on that when it replaces right-to-left.
 */
export function resolveCollisions<T extends Finding>(findings: T[]): T[] {
  // A work queue rather than a single pass: narrowing can produce a part that
  // starts to the right of findings still waiting, so a candidate is no longer
  // guaranteed to meet at most one accepted finding. Anything unsettled goes
  // back on the queue and is re-compared until it overlaps nothing.
  const queue = new FindingQueue<T>();
  for (const finding of [...findings].sort((a, b) => a.span[0] - b.span[0])) {
    queue.push(finding);
  }
  const accepted: T[] = [];

  while (queue.size > 0) {
    const candidate = queue.pop()!;

    // Settle against the leftmost overlapping finding, so the outcome does not
    // depend on the order findings happened to land in `accepted`.
    const overlapIdx = firstOverlap(accepted, candidate);
    if (overlapIdx === -1) {
      insertSorted(accepted, candidate);
      continue;
    }

    const existing = accepted[overlapIdx]!;

    // Keep whatever the winner does not cover, so an over-broad finding is
    // narrowed instead of leaking the text it over-matched. Requeue rather than
    // accept: a part may still collide with something else.
    if (candidateWins(candidate, existing)) {
      accepted.splice(overlapIdx, 1);
      queue.push(candidate);
      for (const part of subtract(existing, candidate)) queue.push(part);
    } else {
      for (const part of subtract(candidate, existing)) queue.push(part);
    }
  }

  return accepted;
}
