---
"@nanocollective/prompt-scrub": patch
---

Fixed a URL on an allowlisted subdomain being half-redacted when it had a path. With `--url-allowlist docs.example.org`, `https://docs.example.org/page` came out as `https://docs.«Url_1»` because the bare `example.org/page` inside it was checked against the allowlist on its own. A full URL on an allowlisted host is now left whole, in the CLI, `config.json` and the proxy alike. Other hosts, including sibling subdomains, are still redacted.
