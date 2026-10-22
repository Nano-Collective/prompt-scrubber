---
"@nanocollective/prompt-scrub": patch
---

Fixed the proxy logging query strings. With `-v`, every request event printed the full request URL, so a provider that takes its key in the query (`?api-key=...`, `?key=...`) had that key written to `stderr`. Request events now carry the path only, as response events and the audit log already did. The startup line no longer prints credentials or a query string given in `--target`. Closes #177.
