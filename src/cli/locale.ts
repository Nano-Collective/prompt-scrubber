import { LOCALE_PATTERN, matchesLocale } from '../core/locale.js';
import type { Detector } from '../types/index.js';

/**
 * Resolves the locale for a single run. An explicit `--locale` overrides the
 * configured one; an empty or absent flag falls back to the config.
 *
 * A malformed flag throws rather than being silently ignored: a user who typed
 * `--locale de_DEE` would otherwise get an English-only scrub while believing
 * their German rules had run. Callers surface the message and exit non-zero.
 */
export function resolveLocale(flag: string | undefined, configured: string | undefined): string {
  const requested = flag?.trim() ?? '';

  if (requested.length === 0) {
    return configured?.trim() ?? '';
  }

  if (!LOCALE_PATTERN.test(requested)) {
    throw new Error(
      `Invalid --locale "${flag}": expected a BCP-47 language tag such as "de-DE" or "pt-BR".`,
    );
  }

  return requested;
}

let localeWarningShown = false;

/** Reset the once-per-process "locale matched nothing" latch (used by tests). */
export function resetLocaleWarning(): void {
  localeWarningShown = false;
}

/**
 * Warns when an active locale switches on no detector at all — a well-formed
 * tag with no rule pack installed for it looks identical to a working setup,
 * so without this the user believes they scrubbed locale-specific PII and did
 * not. Warned once per process because `watch` scrubs on every change.
 */
export function warnIfLocaleUnused(
  locale: string,
  detectors: Detector[],
  warn: (message: string) => void = console.error,
): void {
  if (locale.length === 0 || localeWarningShown) return;

  const activated = detectors.some(
    (d) => d.locales && d.locales.length > 0 && matchesLocale(d.locales, locale),
  );
  if (activated) return;

  localeWarningShown = true;
  warn(
    `Warning: locale "${locale}" activated no detectors. Install a rule pack that declares it and list it under "rulePacks" — \`prompt-scrub rules list\` shows the locales currently loaded.`,
  );
}
