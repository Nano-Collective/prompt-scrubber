---
"@nanocollective/prompt-scrub": patch
---

Several processes can now share one `--session-id` at the same time. `scrub` (and the library `scrub()` with a `sessionId`) holds an exclusive `<id>.json.lock` file from reading the session until saving it. `sessions encrypt`, `sessions rm` and the session garbage collector take the same lock, so they cannot be undone by a scrub that is mid-save (a deleted session coming back on disk, or a live one being pruned). Before, each process read the session on open and rewrote the whole file on save, so parallel runs were given the same placeholder for different values (two emails both became `«Email_1»`) and the last save erased the others' mappings. A process now waits up to 30 seconds for the one ahead of it. A lock left by a crashed process is cleared once it is older than 2 seconds, by one waiter at a time. Saving also retries a rename that Windows refuses (`EPERM`) while another process is reading the file.

The wait is synchronous: while another process holds the lock, `scrub()` blocks the event loop of a library caller for up to 30 seconds and then throws, so a server should not share a session ID between processes (pass `sessionMap` to stay in memory). Using `SessionManager` directly is not locked.
