---
"@nanocollective/prompt-scrub": patch
---

Several processes can now share one `--session-id` at the same time. `scrub` (and the library `scrub()` with a `sessionId`) holds an exclusive `<id>.json.lock` file from reading the session until saving it, and `sessions encrypt` does the same around its rewrite. Before, each process read the session on open and rewrote the whole file on save, so parallel runs were given the same placeholder for different values (two emails both became `«Email_1»`) and the last save erased the others' mappings. A process now waits up to 30 seconds for the one ahead of it, and a lock left by a crashed process is cleared once it is older than 2 seconds. Saving also retries a rename that Windows refuses (`EPERM`) while another process is reading the file. Using `SessionManager` directly is not locked.
