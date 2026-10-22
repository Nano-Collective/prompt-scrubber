---
"@nanocollective/prompt-scrub": patch
---

Fixed the proxy forwarding its `x-prompt-scrub-session` header to the upstream provider. The ID is stable for a whole session, so a provider receiving it could link every prompt of that session, and a client that pinned a long-lived ID could be correlated across time and IP addresses. The header now only travels between the client and the proxy. Closes #165.
