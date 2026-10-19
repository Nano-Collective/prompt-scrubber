---
"@nanocollective/prompt-scrub": minor
---

Added structured observability to the proxy. `--audit-log <path>` appends one JSON line per request with counts, detector categories, timings and the request path. The file is created with mode `0600`. The proxy also serves `GET /healthz` and `GET /metrics` (Prometheus text, or JSON with `?format=json`), with redaction counts by category, latency, errors and passthrough. Pass `--no-metrics` to turn the endpoints off. Audit records and metrics never include values, bodies, headers or query strings. Closes #182.
