---
"@nanocollective/prompt-scrub": patch
---

Fixed **UrlDetector** over-capturing trailing markdown punctuation and parentheses. Trailing sentence punctuation (`.`, `,`, `:`, `?`) and unbalanced closing parentheses or brackets are now excluded from URL findings, preventing corruption of surrounding Markdown links and sentence punctuation while preserving balanced parentheses in URL paths. Thanks to @slopggobblercobbler81. Closes #178.
