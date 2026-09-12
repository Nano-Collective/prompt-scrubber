export const LOCALE_PATTERN = /^[a-z]{2,3}(?:[-_][a-z0-9]{2,8})*$/i;

function normalize(tag: string): string {
  return tag.trim().toLowerCase().replace(/_/g, '-');
}

export function matchesLocale(supported: readonly string[], active?: string): boolean {
  if (!active) return false;
  const target = normalize(active);
  if (target.length === 0) return false;

  return supported.some((tag) => {
    const candidate = normalize(tag);
    return (
      candidate === target ||
      target.startsWith(`${candidate}-`) ||
      candidate.startsWith(`${target}-`)
    );
  });
}
