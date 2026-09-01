---
"@nanocollective/prompt-scrub": patch
---

Fix `watch` destroying data by reusing one placeholder for two different values. Each tick called `handleScrub` with no session ID, so `SessionManager` minted a fresh UUID and started from an empty map; the per-category counter reset to `1` every tick while the file on disk still held «Email_1» from the previous one. The next tick reissued that same token for a different address and wrote it back over the only copy, so both rehydrations were confidently wrong and the distinction was unrecoverable - and a session file accumulated per tick with no ID ever printed to say which one to rehydrate from. `handleWatch` now allocates a single session for the whole run (reusing `--session-id` when given), threads it through every clipboard and file tick, and prints `[watch] Session ID: <id>` on start-up.

The underlying hazard is fixed in the core too: `createPlaceholder` now skips any candidate name that already appears literally in the content being scrubbed, so re-scrubbing scrubbed output no longer collapses a literal «Email_1» and a real address into one token. The reservation is taken over the whole request before any part of it is scrubbed, so it holds regardless of which message a literal token appears in. Placeholder prefixes are matched as `[^«»]+` rather than `[A-Za-z]+` wherever they are parsed - reservation, the category counter, and rehydration - because `placeholderPrefix` is free-form on the public extension surface; a rule pack minting «Ticket2_1» previously both collided and, separately, never rehydrated.

**Behaviour change worth noting:** each tick's `watch` log line and notification are now driven by that scrub's own stats rather than the session map. This is what stops a long-running watcher reporting the running total, but stats count findings while the session map deduplicates by value, so a single input containing the same address twice now reports `Scrubbed 2 emails` where it previously said `Scrubbed 1 email`. The new count reflects what was actually replaced.

Thanks to @addyCooks. Closes #124.
