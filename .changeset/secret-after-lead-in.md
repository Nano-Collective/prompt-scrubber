---
"@nanocollective/prompt-scrub": patch
---

Fixed a secret being left in the clear when its `KEY=value` pair came straight after another word and a colon. `found: API_KEY=...`, `config:` followed by `DB_PASSWORD=...` on the next line, and a secret key nested under a plain YAML key (`env:` then `API_KEY: ...`) are now redacted. A quoted value that is already a placeholder (`api_key="«Secret_1»"`) is no longer redacted a second time, so scrubbing the same text twice gives the same result.
