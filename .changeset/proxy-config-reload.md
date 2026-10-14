---
"@nanocollective/prompt-scrub": minor
---

The proxy now reloads `config.json` without a restart. Reloads run on `SIGHUP` and when the file changes on disk. Only `rulePacks` and `urlAllowlist` reload. An invalid config or a failing rule pack keeps the previous configuration. Pass `--no-reload-config` to turn this off. The proxy also applies the config-file `urlAllowlist` itself, as the `scrub` command does, so the allowlist can reload.
