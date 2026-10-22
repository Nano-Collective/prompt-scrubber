---
"@nanocollective/prompt-scrub": patch
---

Fixed six detector edge cases. An email address at the end of a sentence (`alice@example.com.`) is now found. A secret under a quoted key (`{"api_key": "..."}`) is now found. A password containing `!`, `#`, `$` or similar is taken whole instead of being cut at the first punctuation mark, which left the rest in the clear, a quoted value runs to its closing quote, and an unquoted value in a query string stops at `&` and `?`. A key name containing `token`, `secret`, `password` or `credential` still counts as a secret key wherever the word sits (`refreshtoken`, `clientsecret`), but the weaker words `key`, `pass` and `auth` must be a whole word of the name, so `author`, `monkey` and `compass` no longer count. An `sk-` key must not start in the middle of a word, so `task-force-leader-...` is no longer redacted. `BEARER` in capitals is now recognised. Closes #174.
