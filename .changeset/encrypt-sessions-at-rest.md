---
"@nanocollective/prompt-scrub": minor
---

feat: encrypt local session files at rest

Adds AES-256-GCM with scrypt-derived keys for session files on disk, plus a
new `sessions encrypt` command for migrating existing plaintext sessions.
Keys are supplied through `PROMPT_SCRUB_KEY`, an interactive TTY prompt, or
the new `setCachedEncryptionKey()` API for library users. A typed
`SessionDecryptionError` distinguishes "wrong key" / "tampered file" from
the historical silent-quarantine behaviour.