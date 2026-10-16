---
"@nanocollective/prompt-scrub": patch
---

Fixed a `rulePacks` entry written as an absolute path failing to load on Windows. The specifier reached `import()` verbatim, where a drive letter parses as a URL scheme, so the load was rejected and then swallowed by the existing error handler — the pack silently contributed no detectors instead of reporting the problem. Absolute paths are now resolved as file URLs before import; bare package specifiers and `file://` URLs are unaffected.
