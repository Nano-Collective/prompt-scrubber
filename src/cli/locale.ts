import { LOCALE_PATTERN, matchesLocale } from '../core/locale.js';
import type { RulePackFailure } from '../core/rule-packs.js';
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
const reportedRulePackFailures = new Set<string>();

/**
 * Reset the once-per-process warning latches: the "locale matched nothing" one
 * and the rule-pack load failures one (used by tests).
 */
export function resetCliWarnings(): void {
  localeWarningShown = false;
  reportedRulePackFailures.clear();
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

/**
 * Warns about each configured rule pack that failed to import. A misspelt or
 * uninstalled pack otherwise looks identical to a working setup, and the
 * detectors the user relied on silently never run. The run continues without
 * the pack. Each failure is reported once per process because `watch` scrubs
 * (and so loads the packs) on every change.
 */
export function warnRulePackFailures(
  failed: RulePackFailure[],
  warn: (message: string) => void = console.error,
): void {
  for (const { name, message } of failed) {
    const key = `${name}\n${message}`;
    if (reportedRulePackFailures.has(key)) continue;

    reportedRulePackFailures.add(key);
    warn(
      `Warning: rule pack "${name}" failed to load, so its detectors are not active: ${message}`,
    );
  }
}
