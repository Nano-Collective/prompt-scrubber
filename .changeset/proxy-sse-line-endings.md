---
"@nanocollective/prompt-scrub": patch
---

Fixed the proxy stalling on event streams that use CRLF line endings. Events were split on `\n\n`, which never appears in `\r\n\r\n`, so a CRLF stream was held back until the upstream finished, and a CR-only stream was never rehydrated. Event boundaries now follow the SSE rules for CRLF, CR and LF, including a CRLF split across two chunks. Events are delivered as they arrive, and output events always use LF. Closes #168.
