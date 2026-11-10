---
"@nanocollective/prompt-scrub": patch
---

Fixed a document with many findings stalling the scrubber. Collision resolution rescanned the whole accepted set for every finding, and the scrubbed text was rebuilt by re-slicing the whole string once per finding, so a document with 10,000 findings took about 1.7 seconds; it now takes under 100 milliseconds, with identical output. Closes #175.
