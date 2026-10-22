---
"@nanocollective/prompt-scrub": patch
---

Fixed six detector edge cases. An email address at the end of a sentence (`alice@example.com.`) is now found. A secret under a quoted key (`{"api_key": "..."}`) is now found. A password containing `!`, `#`, `$` or similar is taken whole instead of being cut at the first punctuation mark, which left the rest in the clear, and a quoted value runs to its closing quote. Key names are matched by whole word, so `author`, `monkey` and `compass` no longer count as secret keys. An `sk-` key must not start in the middle of a word, so `task-force-leader-...` is no longer redacted. `BEARER` in capitals is now recognised. Closes #174.
