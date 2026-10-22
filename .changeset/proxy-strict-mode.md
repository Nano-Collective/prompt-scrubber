---
"@nanocollective/prompt-scrub": minor
---

Added `--strict` to `prompt-scrub proxy`, a fail-closed mode. Without it, a body on an unrecognised endpoint (OpenAI `/v1/responses`, Gemini, Azure OpenAI, Ollama), a compressed body, or a body that is not JSON is forwarded to the upstream unscrubbed. With it, those requests are refused with `403` and never sent. Blocked requests are counted in `prompt_scrub_blocked_total{reason}` and recorded in the audit log as `rejected` with `errorKind` `strict_blocked`. The `passthrough` reason for a compressed body is now `compressed body` instead of `non-json body`. It is also available as `strict` on the programmatic `ProxyOptions`. Closes #164.
