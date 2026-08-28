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
 * Returns findings sorted by start position ascending.
 */
export function resolveCollisions(findings: Finding[]): Finding[] {
  // Sort by start position so we process left-to-right
  const sorted = [...findings].sort((a, b) => a.span[0] - b.span[0]);

  const accepted: Finding[] = [];

  for (const candidate of sorted) {
    const overlapIdx = accepted.findIndex((existing) => overlaps(candidate, existing));

    if (overlapIdx === -1) {
      // No overlap — accept immediately
      accepted.push(candidate);
    } else {
      const existing = accepted[overlapIdx]!;
      const candidatePriority = priorityOf(candidate);
      const existingPriority = priorityOf(existing);

      let winner = existing;
      let loser = candidate;
      if (
        candidatePriority < existingPriority ||
        (candidatePriority === existingPriority && candidate.value.length > existing.value.length)
      ) {
        // Candidate wins — replace
        accepted[overlapIdx] = candidate;
        winner = candidate;
        loser = existing;
      }

      // Keep whatever the winner does not cover, so an over-broad finding is
      // narrowed instead of leaking the text it over-matched.
      for (const part of subtract(loser, winner)) {
        if (!accepted.some((existingPart) => overlaps(part, existingPart))) {
          accepted.push(part);
        }
      }
    }
  }

  // Final sort by start position for deterministic output
  return accepted.sort((a, b) => a.span[0] - b.span[0]);
}
