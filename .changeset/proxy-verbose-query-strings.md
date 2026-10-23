---
"@nanocollective/prompt-scrub": patch
---

Fixed the proxy logging query strings. With `-v`, every request event printed the full request URL, so a provider that takes its key in the query (`?api-key=...`, `?key=...`) had that key written to `stderr`. Request events now carry the path only, as response events and the audit log already did. The startup line no longer prints credentials or a query string given in `--target`. The proxy also dropped the query string from every request it forwarded, so `?api-version=` on Azure OpenAI, `?key=` on Gemini and `?limit=` on `/v1/models` never reached the provider; the query string is now forwarded. Closes #177.
