import type {
  ScrubRequest,
  ScrubResult,
  Message,
  Detector,
} from '../types/index.js';
import { SessionManager } from '../session/session-manager.js';
import { resolveCollisions } from './collision-resolver.js';
import { EmailDetector } from '../detectors/email.js';
import { PhoneDetector } from '../detectors/phone.js';
import { UrlDetector } from '../detectors/url.js';
import { PathDetector } from '../detectors/path.js';
import { SecretDetector } from '../detectors/secret.js';

const DEFAULT_DETECTORS: Detector[] = [
  new SecretDetector(),
  new EmailDetector(),
  new UrlDetector(),
  new PathDetector(),
  new PhoneDetector(),
];

/**
 * Scrubs a single string, returning the scrubbed text.
 * All replacements are recorded in the provided SessionManager.
 */
function scrubString(text: string, detectors: Detector[], session: SessionManager): string {
  // Run all detectors and flatten results
  const allFindings = detectors.flatMap((d) => d.detect(text));

  // Resolve overlaps using the priority-based collision resolver
  const findings = resolveCollisions(allFindings);

  if (findings.length === 0) {
    return text;
  }

  // Replace right-to-left so earlier offsets stay valid
  let result = text;
  for (const finding of [...findings].reverse()) {
    const placeholder = session.createPlaceholder(finding.placeholderPrefix, finding.value);
    result =
      result.slice(0, finding.span[0]) +
      placeholder +
      result.slice(finding.span[1]);
  }

  return result;
}

/**
 * Main scrub entry point. Accepts a string or Message[] and returns scrubbed
 * content in the same shape, along with the session ID used.
 */
export function scrub(request: ScrubRequest): ScrubResult {
  const { content, sessionId, options } = request;

  const session = new SessionManager(sessionId);

  // Build active detector list
  const disabledSet = new Set(
    (options?.disabledDetectors ?? []).map((d) => d.toLowerCase().replace('detector', ''))
  );
  const activeDetectors = DEFAULT_DETECTORS.filter(
    (d) => !disabledSet.has(d.name.toLowerCase().replace('detector', ''))
  );
  if (options?.customDetectors) {
    activeDetectors.push(...options.customDetectors);
  }

  let scrubbedContent: string | Message[];

  if (typeof content === 'string') {
    scrubbedContent = scrubString(content, activeDetectors, session);
  } else {
    // Message[] — scrub each message's content independently, preserve structure
    scrubbedContent = content.map((msg) => ({
      ...msg,
      content: scrubString(msg.content, activeDetectors, session),
    }));
  }

  // Only write to disk if something was actually scrubbed
  const mapKeys = Object.keys(session.getMap());
  if (mapKeys.length > 0) {
    session.save();
  }

  return {
    scrubbedContent,
    sessionId: session.getSessionId(),
  };
}
