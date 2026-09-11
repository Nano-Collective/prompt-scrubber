---
"@nanocollective/prompt-scrub": minor
---

feat: add `prompt-scrub proxy` — a local HTTP proxy that scrubs outgoing LLM requests (OpenAI `/v1/chat/completions`, Anthropic `/v1/messages`) and rehydrates responses, including streaming Server-Sent Events, transparently. Session continuity is maintained via an `x-prompt-scrub-session` request/response header.
