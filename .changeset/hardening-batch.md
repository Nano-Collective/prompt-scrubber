---
"@nanocollective/prompt-scrub": patch
---

Hardening pass over the detectors, the session store and the proxy.

- Session IDs are validated. `--session-id ../../x` could read, overwrite or delete any `.json` file outside the sessions directory. An ID must now be 1 to 255 characters without a path separator, `:`, a Windows-reserved character or a control character. Sessions saved earlier under other names keep working.
- The email and bare-endpoint scans are linear on long hyphen, `+` and `%` runs. 100 KB of hyphens took 10 seconds and 100 KB of hyphenated text 5 seconds.
- The proxy now scrubs `user`, `safety_identifier`, `metadata`, `prediction.content` and `response_format.json_schema` descriptions on OpenAI requests, and `document` blocks, `search_result` blocks and `metadata` on Anthropic requests.
- An allowlisted host no longer exempts a URL with a user name, a password, or a credential-named query or fragment parameter such as `api_key`, `token` or `signature`.
- Credentials in a URL or connection string (`postgres://user:pass@host/db`, `mongodb+srv://`, `redis://`, `amqp://`, `https://user:pass@host`) are redacted as one unit instead of being split or leaking the user name.
- Internationalised email addresses match, and an address includes its compass direction, unit and `, City, ST 12345` tail when a ZIP code is present.
- The proxy warns, as `scrub` does, when the configured locale activates no detector.
