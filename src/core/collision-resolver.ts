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
};

function priorityOf(finding: Finding): number {
  // category maps to detector name (e.g. "Email" → "EmailDetector")
  const detectorName = `${finding.category}Detector`;
  return DETECTOR_PRIORITY[detectorName] ?? 99;
}

/**
 * Given a flat array of all findings from all detectors, removes overlapping
 * spans so that the result contains only non-overlapping findings.
 *
 * When two findings overlap, the one from the higher-priority detector wins.
 * Equal-priority overlaps resolve in favour of the longer span.
 *
 * Returns findings sorted by start position ascending.
 */
export function resolveCollisions(findings: Finding[]): Finding[] {
  // Sort by start position so we process left-to-right
  const sorted = [...findings].sort((a, b) => a.span[0] - b.span[0]);

  const accepted: Finding[] = [];

  for (const candidate of sorted) {
    const overlapIdx = accepted.findIndex(
      (existing) => candidate.span[0] < existing.span[1] && candidate.span[1] > existing.span[0],
    );

    if (overlapIdx === -1) {
      // No overlap — accept immediately
      accepted.push(candidate);
    } else {
      const existing = accepted[overlapIdx]!;
      const candidatePriority = priorityOf(candidate);
      const existingPriority = priorityOf(existing);

      if (
        candidatePriority < existingPriority ||
        (candidatePriority === existingPriority && candidate.value.length > existing.value.length)
      ) {
        // Candidate wins — replace
        accepted[overlapIdx] = candidate;
      }
      // Otherwise, existing wins — discard candidate
    }
  }

  // Final sort by start position for deterministic output
  return accepted.sort((a, b) => a.span[0] - b.span[0]);
}
