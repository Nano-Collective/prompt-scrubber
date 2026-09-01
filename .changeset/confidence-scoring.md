---
"@nanocollective/prompt-scrub": minor
---

Add confidence scoring and tiered detection. Every `Finding` now carries a `confidence` (0.0-1.0) and a `method` naming the rule that produced it, so an exact vendor key pattern (0.99, `exact-pattern`) is distinguishable from a high-entropy guess (0.6, `entropy`) or a capitalised-word name (0.5, `heuristic`). A new `--min-confidence <0-1>` flag on `scrub`, `inspect` and `watch` discards findings below a threshold; `minConfidence` does the same in `ScrubOptions` and in the config file, with the flag overriding the configured value. Filtering runs before collision resolution, so a discarded low-confidence finding can never mask a higher-confidence one that overlaps it.

When a threshold does drop something, the tool says so rather than under-redacting silently: `scrub` appends `; N suppressed below --min-confidence X (breakdown)` to its summary, `inspect` lists the dropped entities under a `Suppressed below --min-confidence X:` heading, and `watch` logs the same notice. This is reported even when nothing survived the threshold, which is exactly when the output would otherwise be indistinguishable from a prompt that had nothing sensitive in it. A dropped finding that some surviving finding still redacts is not counted, so the notice reflects what is genuinely left in the clear. `ScrubStats` gains an optional `suppressed` field carrying the same counts.

**Display change:** `inspect` now prints the confidence and method of every entity, and the suppression section above, whether or not a threshold is set. `--min-confidence` itself defaults to `0`, so nothing is filtered and `scrub` output, placeholders and session behaviour are unchanged for existing users. `inspect --hash` is unaffected by the display changes and remains the scripting-stable surface.

`confidence`/`method` are optional on the `Detector` interface, so existing rule packs keep working and their findings are scored at `DEFAULT_CONFIDENCE` (0.5), which is now exported from the package root.
