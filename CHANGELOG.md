# 1.0.1

Refactor to a stateless API and hardening for TUI/agent consumers (e.g. nanocoder). Highlights:

- **Stateless map-passing API** — `scrub()` and `rehydrate()` now accept an optional `sessionMap`, and `scrub()` returns the placeholder→value map. Callers can drive the whole scrub/rehydrate lifecycle from an in-memory map with no hidden global disk state and no session-id lifecycle. The existing session-id/on-disk mode still works. The provided `sessionMap` is mutated in place (and returned as `result.sessionMap`, the same reference), so callers may rely on either.
- **New placeholder format** — placeholders are now delimited as `«Email_1»` instead of `Email_1`, to avoid collisions with genuine code identifiers a model might emit and to survive model reproduction more reliably. Note: session maps written by 1.0.0 (bare `Email_1`) will not rehydrate against 1.0.1-scrubbed content; callers using the stateless map API are unaffected.
- **No more library logging** — removed all `console.warn`/`console.error` from session storage and rule-pack loading. A library writing to stdout/stderr corrupts Ink/TUI rendering in consumers; failures are now handled silently (best-effort) or surfaced via return values.
- **Removed `cwd`-based config** — `loadConfig()` no longer reads `process.cwd()/package.json` for a `prompt-scrub` key. Reading config from an arbitrary working directory was surprising and risky; global config (`PROMPT_SCRUB_CONFIG_DIR`) is unchanged.
- **Faster placeholder reuse** — reverse (value→placeholder) lookup is now O(1) instead of a linear scan per finding.
- **Packaging** — added a `prepare` script so `file:`/git installs always build a fresh `dist` (prevents consumers from linking a stale build).
- **Tests** — session-storage tests are now hermetic on every platform (use `PROMPT_SCRUB_CONFIG_DIR` rather than `XDG_CONFIG_HOME`, which only isolates on Linux), so they no longer read or write the user's real config directory.

# 1.0.0

First public release of `prompt-scrub` — a local-first utility that strips identifying content out of prompts and messages before they reach a cloud LLM, and rehydrates the model's response back to the original values locally.

## Core

- **`scrub()`** — accepts a string or an array of `{ role, content }` messages, replaces detected identifiers with stable, category-namespaced placeholders (`Email_1`, `Secret_1`, `Path_1`, ...), and returns the scrubbed content plus a session id. Deterministic for a given input and session, so provider prompt-cache prefixes stay byte-stable.
- **`rehydrate()`** — swaps placeholders back to their original values. Accepts a string or a message array. Unknown/hallucinated placeholders are passed through unchanged and surfaced as warnings.
- **Session mapping** — placeholder→original maps persist as plain JSON under the OS config dir (macOS/Linux/Windows), with atomic writes, restrictive file permissions, and corrupt-file quarantine. Overridable via `PROMPT_SCRUB_CONFIG_DIR`.
- **Collision resolution** — overlapping detector findings resolve by a documented priority order, longer span winning on ties.

## Detectors

Eight detectors ship in the box:

- **On by default:** email, phone, postal address, path, secret, url.
- **Off by default (opt-in):** name (proper-noun, with a stricter allowlist mode) and code-tell (user-enumerated private identifiers).
- **URL allowlist** — trusted hosts (with subdomain matching) can be passed through unscrubbed.

## CLI

- `prompt-scrub scrub` — scrub stdin/file; prints the session id to stderr.
- `prompt-scrub rehydrate` — restore a response using `--session-id`.
- `prompt-scrub inspect` — dry-run diff of what would change, plus a SHA-256 hash of the scrubbed output (and a `--hash` quiet mode) for verifying cache-prefix stability.
- `prompt-scrub sessions list | show | rm` — manage session maps.
- `prompt-scrub rules list` — list the active detector set, including rule-pack detectors.

## Extensibility

- **Custom detectors** via the library API (`customDetectors` in `ScrubOptions`).
- **Rule packs** — load detectors from separate npm packages declared in config or `package.json`, merged into the active set and surfaced in `rules list`.

## Notes

`prompt-scrub` reduces identity leakage at the content layer. It is partial defence, not anonymity: it does not address stylistic fingerprinting, semantically identifying questions, or the network/key layer. Always run `inspect` first. See the [Threat Model](docs/features/threat-model.md) for the full breakdown.
