---
"@nanocollective/prompt-scrub": patch
---

Fix Windows paths leaking in cleartext when an email or secret appears later on the same line: `WIN_PATH_REGEX` ran greedily to the end of the line, and collision resolution then dropped that over-wide `Path` finding in favour of the higher-priority finding inside it. Quoted and unquoted paths are now matched separately, so `C:\Program Files` and `C:\Users\John Doe` are still matched in full while trailing prose is not. As hardening, `resolveCollisions` narrows a losing finding to the part the winner does not cover instead of discarding it, so an over-broad detector degrades to over-redaction rather than a silent leak.
