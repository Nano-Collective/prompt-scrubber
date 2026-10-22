---
"@nanocollective/prompt-scrub": patch
---

Fixed long API keys being redacted only in part. The `sk-` pattern stopped after 80 characters, so an OpenAI project key (about 164 characters) or an Anthropic key (about 108) kept its tail in the clear. The pattern now matches the whole key. Closes #162.
