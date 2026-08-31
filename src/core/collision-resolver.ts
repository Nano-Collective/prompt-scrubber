import type { Finding } from '../types/index.js';

// Priority table: lower number = higher priority (wins collisions)
const DETECTOR_PRIORITY: Record<string, number> = {
  SecretDetector: 1,
  EmailDetector: 2,
  UrlDetector: 3,
  PathDetector: 4,
  PhoneDetector: 5,
  AddressDetector: 6,
  NameDetector: 7,
  CodeTellDetector: 8,
};

function priorityOf(finding: Finding): number {
  // category maps to detector name (e.g. "Email" → "EmailDetector")
  const detectorName = `${finding.category}Detector`;
  return DETECTOR_PRIORITY[detectorName] ?? 99;
}

function overlaps(a: Finding, b: Finding): boolean {
  return a.span[0] < b.span[1] && a.span[1] > b.span[0];
}

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
 * A returned part is weaker evidence than the match it came from: it is the
 * remainder of a span another detector has already contradicted. Should
 * `Finding` gain a confidence or score field, attenuate it here rather than
 * letting the spread below copy the original match's value onto the fragment.
 */
function subtract(loser: Finding, winner: Finding): Finding[] {
  if (loser.category === winner.category || loser.value.length !== loser.span[1] - loser.span[0]) {
    return [];
  }

  const bounds: [number, number][] = [
    [loser.span[0], Math.min(loser.span[1], winner.span[0])],
    [Math.max(loser.span[0], winner.span[1]), loser.span[1]],
  ];

  const parts: Finding[] = [];
  for (const [start, end] of bounds) {
    const slice = loser.value.slice(start - loser.span[0], end - loser.span[0]);
    const value = slice.trim();
    if (value.length === 0) {
      continue;
    }
    const offset = start + slice.indexOf(value);
    parts.push({ ...loser, span: [offset, offset + value.length], value });
  }
  return parts;
}

/**
 * Given a flat array of all findings from all detectors, removes overlapping
 * spans so that the result contains only non-overlapping findings.
 *
 * When two findings overlap, the one from the higher-priority detector wins.
 * Equal-priority overlaps resolve in favour of the longer span. The loser is
 * kept, narrowed to the part of its span the winner does not cover.
 *
 * Terminates because every overlap either removes a finding outright or
 * replaces one with strictly shorter parts, so the total span length across
 * queue and accepted set strictly decreases each time an overlap is resolved.
 *
 * Returns findings sorted by start position ascending, guaranteed pairwise
 * non-overlapping — `scrub` relies on that when it replaces right-to-left.
 */
export function resolveCollisions(findings: Finding[]): Finding[] {
  const byStart = (a: Finding, b: Finding) => a.span[0] - b.span[0];

  // A work queue rather than a single pass: narrowing can produce a part that
  // starts to the right of findings still waiting, so a candidate is no longer
  // guaranteed to meet at most one accepted finding. Anything unsettled goes
  // back on the queue and is re-compared until it overlaps nothing.
  const queue = [...findings].sort(byStart);
  const accepted: Finding[] = [];

  while (queue.length > 0) {
    const candidate = queue.shift()!;

    // Settle against the leftmost overlapping finding, so the outcome does not
    // depend on the order findings happened to land in `accepted`.
    let overlapIdx = -1;
    for (let i = 0; i < accepted.length; i++) {
      if (!overlaps(candidate, accepted[i]!)) {
        continue;
      }
      if (overlapIdx === -1 || accepted[i]!.span[0] < accepted[overlapIdx]!.span[0]) {
        overlapIdx = i;
      }
    }

    if (overlapIdx === -1) {
      // No overlap — accept
      accepted.push(candidate);
      continue;
    }

    const existing = accepted[overlapIdx]!;
    const candidatePriority = priorityOf(candidate);
    const existingPriority = priorityOf(existing);
    const candidateWins =
      candidatePriority < existingPriority ||
      (candidatePriority === existingPriority && candidate.value.length > existing.value.length);

    // Keep whatever the winner does not cover, so an over-broad finding is
    // narrowed instead of leaking the text it over-matched. Requeue rather than
    // accept: a part may still collide with something else.
    if (candidateWins) {
      accepted.splice(overlapIdx, 1);
      queue.push(candidate, ...subtract(existing, candidate));
    } else {
      queue.push(...subtract(candidate, existing));
    }
    queue.sort(byStart);
  }

  // Final sort by start position for deterministic output
  return accepted.sort(byStart);
}
