---
"@nanocollective/prompt-scrub": minor
---

Added detection of the credential after the `Basic` or `token` scheme of an `Authorization` header, as in `Authorization: Basic dXNlcjpwYXNz...`, `Proxy-Authorization: Basic ...` and `curl -H "Authorization: token ..."`. Only `Bearer` was recognised before, so these were left in the clear. The header name is required, and the value must look like a credential (a digit, a `+` or `/`, or a capital after its first letter), so prose such as "Authorization: Basic authentication" is left alone. Slack bot and user tokens are now also found when their id groups are not exactly 11 digits (9 to 15 digits are accepted), and a longer secret part is no longer cut short.
