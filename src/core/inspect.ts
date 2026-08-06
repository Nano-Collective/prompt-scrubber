import type { InspectRequest, InspectResult } from '../types/index.js';
import { resolveCollisions } from './collision-resolver.js';
import { getActiveDetectors } from './scrub.js';

/**
 * Detects sensitive values without creating or loading a session.
 *
 * This is the inspection primitive used by the CLI and workflow integrations.
 * It deliberately returns the detector findings, including values, because
 * callers use inspect to review what would be scrubbed before sending content
 * anywhere. Integrations should decide whether those values belong in their
 * workflow metadata.
 */
export function inspect(request: InspectRequest): InspectResult {
  const detectors = getActiveDetectors(request.options);
  const findings = resolveCollisions(
    detectors.flatMap((detector) => detector.detect(request.content)),
  );
  const categories: Record<string, number> = {};

  for (const finding of findings) {
    categories[finding.category] = (categories[finding.category] ?? 0) + 1;
  }

  return { findings, categories };
}
