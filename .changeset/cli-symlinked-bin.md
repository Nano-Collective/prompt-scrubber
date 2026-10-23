---
"@nanocollective/prompt-scrub": patch
---

Fixed the CLI doing nothing when installed globally. npm starts a global install through a symlink in the bin directory, and the entry check compared the symlink path with the real file path, so every command exited 0 without output. The check now resolves symlinks. Closes #166.
