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
