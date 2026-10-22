---
"@nanocollective/prompt-scrub": patch
---

Fixed the proxy minting a placeholder that a request already contains literally. A literal `«Email_1»` in one message did not stop another message in the same request, or a later request in the same session, from assigning `«Email_1»` to a real email address, so rehydration restored the wrong value. Literal placeholders are now reserved across every message of a request and for the rest of the session. Closes #169.
