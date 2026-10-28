---
"@nanocollective/prompt-scrub": patch
---

Fixed a `KEY=value` secret being left in the clear when its key came straight after anything other than whitespace, a comma, a semicolon or `{`. A key after a backtick, a bracket, `$`, `@`, `&` or `?` (`` `DB_PASSWORD=...` ``, `(password: ...)`, `$password = "..."`, `user=bob&password=...`), or after non-ASCII punctuation or an emoji, is now redacted. A pair in the query of an `http(s)://` URL (`?token=...`, `&password=...`) is still left to the URL detector, so the URL is redacted whole, however long it is; a pair after a comma or a semicolon, and a pair in a URL the URL detector rejects as malformed, is always reported.
