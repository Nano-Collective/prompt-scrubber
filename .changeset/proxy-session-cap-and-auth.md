---
"@nanocollective/prompt-scrub": minor
---

The proxy no longer grows without bound, and can require a token. Every request without an `x-prompt-scrub-session` header created a session that was never freed, so a long-running proxy leaked memory in proportion to its traffic. Sessions are now created only when a request has something to remember, and the least recently used are dropped past `--max-sessions` (default 1000). A proxy bound to a non-loopback `--host` now logs a warning, and `--auth-token` (or `PROMPT_SCRUB_AUTH_TOKEN`) makes it require an `x-prompt-scrub-token` header on every request except `/healthz`; the header is never forwarded upstream. Closes #172.
