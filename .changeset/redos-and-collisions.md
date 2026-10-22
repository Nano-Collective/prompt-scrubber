---
"@nanocollective/prompt-scrub": patch
---

Fixed two ways a large or hostile input could stall the scrubber. The email scan was quadratic on a long run of `-`, `+` or `%`: `a@` followed by 40,000 hyphens took about 1.5 seconds and 100,000 took 10. Collision resolution rescanned the whole accepted set for every finding, and the scrubbed text was rebuilt by re-slicing the whole string once per finding, so a document with 10,000 findings took about 1.7 seconds; it now takes under 100 milliseconds, with identical output. Closes #175.
