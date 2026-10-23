---
"@nanocollective/prompt-scrub": patch
---

Fixed a rule pack that fails to load being skipped without a word. A misspelt or uninstalled package in `rulePacks`, or a pack that throws while loading, left its detectors silently inactive, so a prompt was scrubbed with fewer rules than the config promised. `scrub`, `inspect`, `rules list`, `watch` and `proxy` now warn on `stderr`, once per run, naming the pack and the reason, and carry on without it. Closes #176.
