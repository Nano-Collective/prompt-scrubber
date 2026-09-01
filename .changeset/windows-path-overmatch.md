---
"@nanocollective/prompt-scrub": patch
---

Fix Windows paths leaking in cleartext when an email or secret appears later on the same line: `WIN_PATH_REGEX` ran greedily to the end of the line, and collision resolution then dropped that over-wide `Path` finding in favour of the higher-priority finding inside it. Quoted paths are now matched as a whole, and an unquoted path continues over a space when the next token contains a backslash, looks like a path component, or carries a file extension — so `C:\Users\john smith\creds.json` and `C:\data\quarterly report.xlsx` are matched in full while `C:\app\cfg.ini owner` stops at the file. As hardening, `resolveCollisions` narrows a losing finding to the part the winner does not cover instead of discarding it, so an over-broad detector degrades to over-redaction rather than a silent leak.
