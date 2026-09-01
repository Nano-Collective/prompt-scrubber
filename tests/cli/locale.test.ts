import test from 'ava';
import { resetLocaleWarning, resolveLocale, warnIfLocaleUnused } from '../../src/cli/locale.js';
import type { Detector } from '../../src/types/index.js';

const noop: Detector = { name: 'NoopDetector', detect: () => [] };
const german: Detector = { name: 'GermanDetector', locales: ['de-DE'], detect: () => [] };

test('resolveLocale prefers the flag over the configured locale', (t) => {
  t.is(resolveLocale('pt-BR', 'de-DE'), 'pt-BR');
});

test('resolveLocale falls back to the configured locale', (t) => {
  t.is(resolveLocale(undefined, 'de-DE'), 'de-DE');
  t.is(resolveLocale('', 'de-DE'), 'de-DE');
  t.is(resolveLocale('   ', 'de-DE'), 'de-DE');
});

test('resolveLocale returns an empty string when neither is set', (t) => {
  t.is(resolveLocale(undefined, undefined), '');
  t.is(resolveLocale(undefined, ''), '');
});

test('resolveLocale trims the flag', (t) => {
  t.is(resolveLocale('  de-DE  ', ''), 'de-DE');
});

test('resolveLocale rejects a malformed flag instead of ignoring it', (t) => {
  for (const bad of ['German!', 'd', '123', 'de-', 'de-DE-']) {
    const error = t.throws(() => resolveLocale(bad, 'de-DE'));
    t.true(error?.message.includes(bad), bad);
    t.true(error?.message.includes('BCP-47'), bad);
  }
});

test('resolveLocale accepts the same tag shapes as the config validator', (t) => {
  // Deliberately the same LOCALE_PATTERN, so `--locale` and `locale` in the
  // config file can never disagree about what a usable tag looks like.
  for (const tag of ['de', 'de-DE', 'de_DE', 'pt-BR', 'zh-Hans-CN']) {
    t.is(resolveLocale(tag, ''), tag, tag);
  }
});

test('resolveLocale does not re-validate an already-rejected config locale', (t) => {
  // readConfigFile drops a malformed `locale`, so an empty config value here
  // is the normal case rather than an error.
  t.is(resolveLocale(undefined, ''), '');
});

test('warnIfLocaleUnused stays silent when a detector matches', (t) => {
  resetLocaleWarning();
  const messages: string[] = [];
  warnIfLocaleUnused('de-DE', [noop, german], (m) => messages.push(m));
  t.deepEqual(messages, []);
});

test('warnIfLocaleUnused stays silent when no locale is active', (t) => {
  resetLocaleWarning();
  const messages: string[] = [];
  warnIfLocaleUnused('', [noop], (m) => messages.push(m));
  t.deepEqual(messages, []);
});

test('warnIfLocaleUnused warns when a valid locale activates nothing', (t) => {
  resetLocaleWarning();
  const messages: string[] = [];
  warnIfLocaleUnused('pt-BR', [noop, german], (m) => messages.push(m));
  t.is(messages.length, 1);
  t.true(messages[0]?.includes('pt-BR'));
  t.true(messages[0]?.includes('no detectors'));
});

test('warnIfLocaleUnused warns at most once per process', (t) => {
  resetLocaleWarning();
  const messages: string[] = [];
  warnIfLocaleUnused('pt-BR', [], (m) => messages.push(m));
  warnIfLocaleUnused('pt-BR', [], (m) => messages.push(m));
  warnIfLocaleUnused('ja-JP', [], (m) => messages.push(m));
  t.is(messages.length, 1);
});
