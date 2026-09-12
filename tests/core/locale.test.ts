import test from 'ava';
import { LOCALE_PATTERN, matchesLocale } from '../../src/core/locale.js';

test('matches an exact tag', (t) => {
  t.true(matchesLocale(['de-DE'], 'de-DE'));
});

test('matches case-insensitively', (t) => {
  t.true(matchesLocale(['de-DE'], 'DE-de'));
  t.true(matchesLocale(['PT-br'], 'pt-BR'));
});

test('treats underscore separators as hyphens', (t) => {
  t.true(matchesLocale(['de-DE'], 'de_DE'));
  t.true(matchesLocale(['de_DE'], 'de-DE'));
});

test('a language-only pack matches any region of that language', (t) => {
  t.true(matchesLocale(['de'], 'de-DE'));
  t.true(matchesLocale(['de'], 'de-AT'));
});

test('a language-only request matches region-specific packs', (t) => {
  t.true(matchesLocale(['de-DE'], 'de'));
});

test('does not match a different region of the same language', (t) => {
  t.false(matchesLocale(['de-DE'], 'de-AT'));
});

test('does not match a different language', (t) => {
  t.false(matchesLocale(['de-DE'], 'fr-FR'));
});

test('does not match on a partial subtag', (t) => {
  t.false(matchesLocale(['de'], 'den'));
  t.false(matchesLocale(['den'], 'de'));
});

test('matches when any supported tag matches', (t) => {
  t.true(matchesLocale(['fr-FR', 'de-DE'], 'de-DE'));
});

test('returns false when no locale is active', (t) => {
  t.false(matchesLocale(['de-DE']));
  t.false(matchesLocale(['de-DE'], ''));
  t.false(matchesLocale(['de-DE'], '   '));
});

test('returns false for an empty supported list', (t) => {
  t.false(matchesLocale([], 'de-DE'));
});

test('ignores surrounding whitespace', (t) => {
  t.true(matchesLocale([' de-DE '], '  de-DE  '));
});

test('LOCALE_PATTERN accepts well-formed tags', (t) => {
  for (const tag of ['de', 'de-DE', 'pt-BR', 'ja-JP', 'zh-Hans-CN', 'de_DE']) {
    t.true(LOCALE_PATTERN.test(tag), tag);
  }
});

test('LOCALE_PATTERN rejects malformed tags', (t) => {
  for (const tag of ['', 'd', 'german!', 'de-', '123', 'de-DE-']) {
    t.false(LOCALE_PATTERN.test(tag), tag);
  }
});
