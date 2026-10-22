---
"@nanocollective/prompt-scrub": patch
---

Fixed the proxy ignoring `minConfidence` and `locale` from `config.json`. Findings scored below the configured threshold were still redacted, and locale-scoped rule pack detectors never ran. Both keys now apply from startup and reload with the config file, like `rulePacks` and `urlAllowlist`. Closes #173.
