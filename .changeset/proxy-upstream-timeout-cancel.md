---
"@nanocollective/prompt-scrub": minor
---

The proxy upstream timeout is now configurable and much longer, and a client that hangs up cancels the upstream request. The hardcoded 30 second timeout cut off reasoning models that take longer than that to emit a first token. It is now an idle timeout of 10 minutes by default, set with `--upstream-timeout <seconds>` (`0` for none) or `upstreamTimeoutMs`. Before, a client that disconnected while the upstream was still thinking, or while a JSON body was arriving, left the upstream request running to completion; it is now dropped and recorded as `client_aborted`. Closes #171.
