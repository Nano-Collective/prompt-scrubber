import { CodeTellDetector } from '../detectors/code-tell.js';
import { EmailDetector } from '../detectors/email.js';
import { NameDetector } from '../detectors/name.js';
import { PathDetector } from '../detectors/path.js';
import { PhoneDetector } from '../detectors/phone.js';
import { PostalAddressDetector } from '../detectors/postal-address.js';
import { SecretDetector } from '../detectors/secret.js';
import { UrlDetector } from '../detectors/url.js';
import { SessionManager } from '../session/session-manager.js';
import type {
  Detector,
  Message,
  ScoredFinding,
  ScrubRequest,
  ScrubResult,
  ScrubStats,
} from '../types/index.js';
import { resolveCollisions } from './collision-resolver.js';

const DEFAULT_DETECTORS: Detector[] = [
  new SecretDetector(),
  new EmailDetector(),
  new UrlDetector(),
  new PathDetector(),
  new PhoneDetector(),
  new PostalAddressDetector(),
];

// Confidence assumed for findings from detectors that do not report one.
export const DEFAULT_CONFIDENCE = 0.5;

// Method reported for findings from detectors that do not name one.
const DEFAULT_METHOD = 'unspecified';

/**
 * Whether `span` is entirely covered by `kept`, which resolveCollisions has
 * already left sorted ascending and non-overlapping.
 *
 * A below-threshold finding whose span another finding redacts anyway is not
 * under-redaction, so it must not be reported as suppressed — a summary that
 * cries wolf on every overlapping detector teaches users to ignore it.
 */
function isCovered(span: [number, number], kept: ScoredFinding[]): boolean {
  let cursor = span[0];
  for (const finding of kept) {
    if (finding.span[1] <= cursor) continue;
    // A gap before this finding starts means part of the span survives in the clear.
    if (finding.span[0] > cursor) return false;
    cursor = finding.span[1];
    if (cursor >= span[1]) return true;
  }
  return cursor >= span[1];
}

export interface DetectionResult {
  /** Findings that passed the threshold, with overlaps resolved. */
  findings: ScoredFinding[];
  /**
   * Findings the threshold dropped that nothing else covers. Overlaps among
   * these are resolved too, so this counts distinct regions left in the clear
   * rather than raw detector hits.
   */
  suppressed: ScoredFinding[];
}

/**
 * Runs every detector over `text`, drops findings scored below `minConfidence`,
 * then resolves the remaining overlaps.
 *
 * Filtering happens before collision resolution so a discarded low-confidence
 * finding can never suppress a higher-confidence one that overlaps it.
 *
 * Returns the dropped findings alongside the kept ones so callers can tell the
 * user what a threshold cost them instead of silently under-redacting.
 */
export function runDetectors(
  text: string,
  detectors: Detector[],
  minConfidence = 0,
): DetectionResult {
  const scored: ScoredFinding[] = detectors.flatMap((d) =>
    d.detect(text).map((finding) => ({
      ...finding,
      confidence: finding.confidence ?? DEFAULT_CONFIDENCE,
      method: finding.method ?? DEFAULT_METHOD,
    })),
  );

  if (minConfidence <= 0) {
    return { findings: resolveCollisions(scored), suppressed: [] };
  }

  const passing: ScoredFinding[] = [];
  const below: ScoredFinding[] = [];
  for (const finding of scored) {
    (finding.confidence >= minConfidence ? passing : below).push(finding);
  }

  const findings = resolveCollisions(passing);
  const suppressed = resolveCollisions(below).filter((f) => !isCovered(f.span, findings));

  return { findings, suppressed };
}

/**
 * Scrubs a single string, returning the scrubbed text.
 * All replacements are recorded in the provided SessionManager and counted into `stats`.
 */
function scrubString(
  text: string,
  detectors: Detector[],
  session: SessionManager,
  stats: ScrubStats,
  minConfidence: number,
): string {
  const { findings, suppressed } = runDetectors(text, detectors, minConfidence);

  // Counted before the early return: a message where the threshold dropped
  // everything still has something the caller needs to hear about.
  for (const finding of suppressed) {
    const bucket = (stats.suppressed ??= { total: 0, byCategory: {} });
    bucket.total += 1;
    bucket.byCategory[finding.category] = (bucket.byCategory[finding.category] ?? 0) + 1;
  }

  if (findings.length === 0) {
    return text;
  }

  for (const finding of findings) {
    stats.totalEntities += 1;
    stats.byCategory[finding.category] = (stats.byCategory[finding.category] ?? 0) + 1;
  }

  // Replace right-to-left so earlier offsets stay valid
  let result = text;
  for (const finding of [...findings].reverse()) {
    const placeholder = session.createPlaceholder(finding.placeholderPrefix, finding.value);
    result = result.slice(0, finding.span[0]) + placeholder + result.slice(finding.span[1]);
  }

  return result;
}

export function getActiveDetectors(options?: ScrubRequest['options']): Detector[] {
  const activeDetectors = [...DEFAULT_DETECTORS];

  if (options?.enabledDetectors) {
    for (const detectorName of options.enabledDetectors) {
      if (detectorName === 'NameDetector') {
        activeDetectors.push(new NameDetector(options?.strictNameDetector));
      } else if (detectorName === 'CodeTellDetector') {
        activeDetectors.push(new CodeTellDetector(options?.codeTellTerms));
      }
    }
  }

  if (
    options?.codeTellTerms &&
    options.codeTellTerms.length > 0 &&
    !options?.enabledDetectors?.includes('CodeTellDetector')
  ) {
    activeDetectors.push(new CodeTellDetector(options.codeTellTerms));
  }

  if (options?.urlAllowlist && options.urlAllowlist.length > 0) {
    const idx = activeDetectors.findIndex((d) => d.name === 'UrlDetector');
    if (idx !== -1) {
      activeDetectors[idx] = new UrlDetector(options.urlAllowlist);
    }
  }

  let detectors = activeDetectors;
  if (options?.disabledDetectors) {
    const disabledSet = new Set(
      options.disabledDetectors.map((d) => d.toLowerCase().replace('detector', '')),
    );
    detectors = detectors.filter(
      (d) => !disabledSet.has(d.name.toLowerCase().replace('detector', '')),
    );
  }

  if (options?.customDetectors) {
    detectors.push(...options.customDetectors);
  }

  return detectors;
}

/**
 * Main scrub entry point. Accepts a string or Message[] and returns scrubbed
 * content in the same shape, along with the placeholder→value map.
 *
 * Stateless mode: when `sessionMap` is provided, no disk state is used and the
 * map is the single source of truth. NOTE: the provided `sessionMap` object is
 * mutated in place as new placeholders are created (it is also returned as
 * `result.sessionMap`, which is the same reference). Callers may rely on either
 * the returned value or the in-place mutation, but must not pass a frozen map.
 */
export function scrub(request: ScrubRequest): ScrubResult {
  const { content, sessionId, sessionMap, options } = request;

  const session = new SessionManager(sessionId, sessionMap);
  const detectors = getActiveDetectors(options);
  const stats: ScrubStats = { totalEntities: 0, byCategory: {} };
  const minConfidence = options?.minConfidence ?? 0;

  let scrubbedContent: string | Message[];

  if (typeof content === 'string') {
    scrubbedContent = scrubString(content, detectors, session, stats, minConfidence);
  } else {
    // Message[] — scrub each message's content independently, preserve structure
    scrubbedContent = content.map((msg) => ({
      ...msg,
      content: scrubString(msg.content, detectors, session, stats, minConfidence),
    }));
  }

  // Only write to disk if something was actually scrubbed
  const mapKeys = Object.keys(session.getMap());
  if (mapKeys.length > 0) {
    session.save();
  }

  const res: ScrubResult = {
    scrubbedContent,
    sessionMap: session.getMap(),
    stats,
  };
  const sid = session.getSessionId();
  if (sid) {
    res.sessionId = sid;
  }
  return res;
}
