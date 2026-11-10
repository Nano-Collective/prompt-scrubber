---
"@nanocollective/prompt-scrub": minor
---

**Behaviour changes in this release**, for anyone upgrading. Each is described in full in its entry below.

  - New session IDs must be 1 to 255 characters without `/`, `\`, `:`, `*`, `?`, `"`, `<`, `>`, `|` or control characters. Existing session files keep working.
  - `scrub()` with a `sessionId` takes a lock on the session file and can block for up to 30 seconds, then throw `SessionLockTimeoutError`, while another process uses the same session.
  - Detector priority changed with the new CreditCard, Iban, Ssn and IpAddress detectors, so some placeholders change category.
  - Proxy: the upstream timeout is now a 10 minute idle timeout (it was a fixed 30 seconds), query strings are forwarded upstream, the `x-prompt-scrub-session` header is no longer forwarded, and the `passthrough` reason for a compressed body is `compressed body` (it was `non-json body`).
