---
"@nanocollective/prompt-scrub": patch
---

Fixed the proxy forwarding a request body unscrubbed when the JSON started with a UTF-8 byte order mark, which Windows PowerShell and some editors add. The mark is now skipped before the body is parsed, so the request is scrubbed, or accepted in `--strict` mode, like any other.
