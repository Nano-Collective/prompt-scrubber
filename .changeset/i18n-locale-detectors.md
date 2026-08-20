---
"@nanocollective/prompt-scrub": minor
---

Add locale-aware detector support so rule packs can ship non-English coverage instead of bloating core. Detectors may declare a `locales` field (BCP-47) and then run only when a matching locale is active; detectors without one stay locale-agnostic and always run. A `locale` config key and a `--locale` flag on `scrub` and `inspect` select the active locale, with the flag overriding the config. Matching is case-insensitive and crosses subtag levels, so a `de` pack serves `de-DE` and `de-AT`, and a `de-DE` pack answers a `de` request. Locale findings outrank the generic built-in of the same category in collision resolution, letting a locale pack replace an English-biased match, while higher-priority detectors such as `SecretDetector` still win. `rules list` gains a locales column showing declared locales and whether the active locale switches each detector on. Closes #96.
