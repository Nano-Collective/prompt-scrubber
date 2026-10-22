---
"@nanocollective/prompt-scrub": patch
---

Fixed the proxy ignoring `minConfidence` and `locale` from `config.json`. Findings scored below the configured threshold were still redacted, and locale-scoped rule pack detectors never ran. Both keys now apply from startup and reload with the config file, like `rulePacks` and `urlAllowlist`. Because a threshold leaves low-scoring findings unredacted, the proxy logs the threshold at startup and on reload, adds `suppressed` and `suppressedByCategory` to each `response` event and audit record, and exposes `prompt_scrub_suppressed_total{category}` on `/metrics`. Closes #173.
