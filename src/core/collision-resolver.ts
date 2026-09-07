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

/**
 * A finding carrying the extra bookkeeping collision resolution needs.
 *
 * `localeScoped` is set by `detectFindings` for every finding produced by a
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
  }

  return candidate.value.length > existing.value.length;
}

/**
 * Given a flat array of all findings from all detectors, removes overlapping
 * spans so that the result contains only non-overlapping findings.
 *
 * When two findings overlap, the one from the higher-priority detector wins.
 * Within one category a locale-scoped finding takes precedence, but only when
 * it covers the same text as the finding it would displace or more — it never
 * wins by covering less, whether it sits strictly inside the other finding or
 * only partially overlaps it. Remaining ties resolve in favour of the longer
 * span.
 *
 * Returns findings sorted by start position ascending.
 */
export function resolveCollisions(findings: ResolvableFinding[]): ResolvableFinding[] {
  // Sort by start position so we process left-to-right
  const sorted = [...findings].sort((a, b) => a.span[0] - b.span[0]);

  const accepted: ResolvableFinding[] = [];

  for (const candidate of sorted) {
    const overlapIdx = accepted.findIndex(
      (existing) => candidate.span[0] < existing.span[1] && candidate.span[1] > existing.span[0],
    );

    if (overlapIdx === -1) {
      // No overlap — accept immediately
      accepted.push(candidate);
    } else if (candidateWins(candidate, accepted[overlapIdx]!)) {
      accepted[overlapIdx] = candidate;
    }
    // Otherwise, existing wins — discard candidate
  }

  // Final sort by start position for deterministic output
  return accepted.sort((a, b) => a.span[0] - b.span[0]);
}
