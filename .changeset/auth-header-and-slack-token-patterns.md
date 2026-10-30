---
"@nanocollective/prompt-scrub": patch
---

Fixed a credential being left in the clear after the `Basic` or `token` scheme of an `Authorization` header, as in `Authorization: Basic dXNlcjpwYXNz...`, `Proxy-Authorization: Basic ...` and `curl -H "Authorization: token ..."`. Only `Bearer` was recognised: the key scan took the scheme word as the whole value and stopped at the space. The header name is required, so ordinary prose such as "Basic authentication" is left alone. Slack bot and user tokens are now also found when their id groups are not exactly 11 digits (9 to 15 digits are accepted), and a longer secret part is no longer cut short.
