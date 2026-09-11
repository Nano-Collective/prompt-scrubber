# @nanocollective/prompt-scrub

# 1.1.0

- Add confidence scoring and tiered detection. Every `Finding` now carries a `confidence` (0.0-1.0) and a `method` naming the rule that produced it, so an exact vendor key pattern (0.99, `exact-pattern`) is distinguishable from a high-entropy guess (0.6, `entropy`) or a capitalised-word name (0.5, `heuristic`). A new `--min-confidence <0-1>` flag on `scrub`, `inspect` and `watch` discards findings below a threshold; `minConfidence` does the same in `ScrubOptions` and in the config file, with the flag overriding the configured value. Filtering runs before collision resolution, so a discarded low-confidence finding can never mask a higher-confidence one that overlaps it. This is a guarantee about filtering, not about collision resolution generally: two findings that both clear the threshold still resolve by detector priority, exactly as before this feature — a low-confidence finding can still win over a higher-confidence one it overlaps.

When a threshold does drop something, the tool says so rather than under-redacting silently: `scrub` appends `; N suppressed below --min-confidence X (breakdown)` to its summary, `inspect` lists the dropped entities under a `Suppressed below --min-confidence X:` heading, and `watch` logs the same notice. This is reported even when nothing survived the threshold, which is exactly when the output would otherwise be indistinguishable from a prompt that had nothing sensitive in it. A dropped finding that some surviving finding still redacts is not counted, so the notice reflects what is genuinely left in the clear. `ScrubStats` gains an optional `suppressed` field carrying the same counts.

**Display change:** `inspect` now prints the confidence and method of every entity, and the suppression section above, whether or not a threshold is set. `--min-confidence` itself defaults to `0`, so nothing is filtered and `scrub` output, placeholders and session behaviour are unchanged for existing users. `inspect --hash` is unaffected by the display changes and remains the scripting-stable surface.

`confidence`/`method` are optional on the `Detector` interface, so existing rule packs keep working and their findings are scored at `DEFAULT_CONFIDENCE` (0.5), which is now exported from the package root.

**Interaction with narrowed findings:** when collision resolution narrows an over-broad finding instead of discarding it (see the Windows-path-overmatch fix), the surviving fragment's `confidence` is reduced to 80% of the original rather than carried over unchanged - it is weaker evidence than the full match that produced it, so a narrowed finding can drop below a `--min-confidence` threshold the original would have cleared.
- feat: implement session TTL and auto-expiry cleanup
- Add a `watch` command for real-time clipboard/file monitoring with auto-scrubbing (`--clipboard`, `--file <files...>`, plus `--dry-run`, `--backup`, `--interval`, `--once`, `--session-id`, `--disable`/`--enable`, `--url-allowlist`; cross-platform Win/macOS/Linux, clean `Ctrl-C` exit, install hints for missing `xclip`/`notify-send`/`osascript`); a one-line `scrub` summary printed to stderr with a `-q`/`--quiet` flag for pipelines, also exposed to library callers as `result.stats` (`totalEntities`, `byCategory`); and `init` + `config show` commands to scaffold and inspect the global config. Fix: cross-platform build script (`rm -rf` → Node `fs.rmSync`); phone-detector span start index; common-name detection in strict mode; watch-mode review feedback. Thanks to @addyCooks and @prashantbhudwal.

- chore: address baseline CI findings (semgrep + adjacent hardening)

The shared Nano-Collective/.github pr-checks workflow now runs
`semgrep scan --config auto --error` against the whole repo, which
exposes pre-existing baseline issues that the previous workflow
configuration tolerated:

- `src/detectors/code-tell.ts`: drop the `new RegExp(...)` built
  from user input in favour of a single-pass character scan with
  per-term length and term-count caps. Word-boundary semantics and
  the longest-match preference are preserved; all existing detector
  tests still pass. The constructor now exposes a `getDiagnostics()`
  API that reports any terms dropped because they exceeded the caps.

- `pnpm-workspace.yaml`: add the three supply-chain hardening
  settings (`blockExoticSubdeps`, `minimumReleaseAge`,
  `trustPolicy`) at the top level, per the current pnpm schema.

- `.github/dependabot.yml`: add a 7-day cooldown to both ecosystem
  blocks so freshly published packages get a settling period
  before being proposed.
- Fix `watch` destroying data by reusing one placeholder for two different values: each tick called `handleScrub` with no session ID, so `SessionManager` minted a fresh UUID and started from an empty map, the per-category counter reset to `1` every tick, and the next tick reissued «Email_1» - still on disk from the previous one - for a different address, overwriting the only copy in place with no session ID ever printed to say which of the accumulating session files could restore it. `handleWatch` now allocates a single session for the whole run (reusing `--session-id` when given), threads it through every clipboard and file tick, and prints `[watch] Session ID: <id>` on start-up. The same hazard was reachable from a single `scrub()` call on input that already contains a placeholder-shaped token, so `createPlaceholder` now reserves those tokens - over the whole request, independent of message order - before minting new ones, and reservation, the category counter, and rehydration all now recognise the free-form, whitespace-free prefixes a rule pack can mint rather than just `[A-Za-z]+`. **Behaviour change:** each tick's `watch` log line and notification are now driven by that scrub's own stats rather than the session map, so a single input containing the same value twice now reports e.g. `Scrubbed 2 emails` where it previously said `Scrubbed 1 email`. Thanks to @addyCooks. Closes #124.
- Fix Windows paths leaking in cleartext when an email or secret appears later on the same line: `WIN_PATH_REGEX` ran greedily to the end of the line, and collision resolution then dropped that over-wide `Path` finding in favour of the higher-priority finding inside it. Quoted paths are now matched as a whole, and an unquoted path continues over a space when the next token contains a backslash, looks like a path component, or carries a file extension — so `C:\Users\john smith\creds.json` and `C:\data\quarterly report.xlsx` are matched in full while `C:\app\cfg.ini owner` stops at the file. As hardening, `resolveCollisions` narrows a losing finding to the part the winner does not cover instead of discarding it, so an over-broad detector degrades to over-redaction rather than a silent leak.

# 1.0.2

Patch release — dev-dependency and CI maintenance only. No public-API or runtime changes.

- **`@biomejs/biome`** — `^2.5.1` → `^2.5.2` (devDependency, via dependabot). Resolves the CLI/schema version warning at lint time (CLI `2.5.3` was reporting that the configured `2.5.1` schema was stale).
- **`ava`** — `^5.3.1` → `^8.0.1` (devDependency, via dependabot). Bumps the test-runner major; no test-suite changes were needed.
- **`knip`** — `^6.23.0` → `^6.25.0` (devDependency, via dependabot). No findings change.
- **GitHub Actions** — bumps via dependabot:
  - `actions/checkout` `4` → `7`
  - `pnpm/action-setup` `4` → `6`
  - `actions/setup-node` `4` → `6`
  - `actions/github-script` `7` → `9`

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
