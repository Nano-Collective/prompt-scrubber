/**
 * Adds `by` to `counts[key]`. The keys are detector categories, which a rule pack
 * may name anything, so an inherited property (`constructor`, `toString`) must not
 * be read as an existing count, and `__proto__` must be stored as a plain key.
 */
export function addCount(counts: Record<string, number>, key: string, by = 1): void {
  const current = Object.hasOwn(counts, key) ? counts[key]! : 0;
  Object.defineProperty(counts, key, {
    value: current + by,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}
