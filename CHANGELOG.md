# @nanocollective/prompt-scrub

# 1.5.0

- feat: add built-in detectors for Credit Cards, SSN, IBAN, and IP Addresses (closes #89)

> **Note:** Collision priority for shared shapes has shifted. CreditCard / IBAN / SSN / IPAddress detectors are inserted above Email / Url / Path / Phone / Address, so e.g. an IP embedded in a URL is now part of the Url finding (Url wins by span length) rather than a separate IpAddress entity.
- Added structured observability to the proxy. `--audit-log <path>` appends one JSON line per request with counts, detector categories, timings and the request path. The file is created with mode `0600`. The proxy also serves `GET /healthz` and `GET /metrics` (Prometheus text, or JSON with `?format=json`), with redaction counts by category, latency, errors and passthrough. Pass `--no-metrics` to turn the endpoints off. Audit records and metrics never include values, bodies, headers or query strings. Closes #182.
- The proxy now reloads `config.json` without a restart. Reloads run on `SIGHUP` and when the file changes on disk. Only `rulePacks` and `urlAllowlist` reload. An invalid config or a failing rule pack keeps the previous configuration. Pass `--no-reload-config` to turn this off. The proxy also applies the config-file `urlAllowlist` itself, as the `scrub` command does, so the allowlist can reload.
- The proxy no longer grows without bound, and can require a token. Every request without an `x-prompt-scrub-session` header created a session that was never freed, so a long-running proxy leaked memory in proportion to its traffic. Sessions are now created only when a request has something to remember, and the least recently used are dropped past `--max-sessions` (default 1000). A proxy bound to a non-loopback `--host` now logs a warning, and `--auth-token` (or `PROMPT_SCRUB_AUTH_TOKEN`) makes it require an `x-prompt-scrub-token` header on every request except `/healthz`; the header is never forwarded upstream. Closes #172.
- Added `--strict` to `prompt-scrub proxy`, a fail-closed mode. Without it, a body on an unrecognised endpoint (OpenAI `/v1/responses`, Gemini, Azure OpenAI, Ollama), a compressed body, or a body that is not JSON is forwarded to the upstream unscrubbed. With it, those requests are refused with `403` and never sent. Blocked requests are counted in `prompt_scrub_blocked_total{reason}` and recorded in the audit log as `rejected` with `errorKind` `strict_blocked`. The `passthrough` reason for a compressed body is now `compressed body` instead of `non-json body`. It is also available as `strict` on the programmatic `ProxyOptions`. Closes #164.
- Fixed the **proxy** dropping messages and leaking PII in tool-calling conversations. `messages[]` was filtered by the presence of a `content` key, so an assistant turn that carries only `tool_calls` was deleted from the forwarded body and the upstream saw a tool result answering a call it had never been told about. Messages are now walked, never filtered: anything the proxy does not recognise is forwarded unchanged at its original position.

The same pass now scrubs the fields tool-calling requests actually put text in, all of which were previously forwarded in the clear: Anthropic's top-level `system` prompt (string or text blocks), `tool_calls[].function.arguments`, `tool_use.input`, `tool_result` blocks, the `description` fields of `tools[]` and their JSON schemas, and the deprecated-but-still-accepted `function_call.arguments` / `functions[]`. Argument strings are parsed and scrubbed value by value, so argument keys and JSON structure survive untouched.

Responses are rehydrated in the same places, since the client executes those tool calls on its own machine and needs the real values back. On a stream that includes holding a trailing partial placeholder back until the next fragment of the same call arrives: vendors emit roughly one token per event, so `«Email_1»` normally arrives in pieces, and resolving it only within a single event would have handed the caller's own code a literal placeholder most of the time.

> **Note:** tool names, tool-call ids, schema property keys and `enum` values are deliberately left alone — the model must echo them back verbatim for the caller's dispatch to work. `tool_use.input` in an Anthropic *response* is now rehydrated, where previously it was left holding placeholders.

Closes #163.
- The proxy upstream timeout is now configurable and much longer, and a client that hangs up cancels the upstream request. The hardcoded 30 second timeout cut off reasoning models that take longer than that to emit a first token. It is now an idle timeout of 10 minutes by default, set with `--upstream-timeout <seconds>` (`0` for none). Before, a client that disconnected while the upstream was still thinking, or while a JSON body was arriving, left the upstream request running to completion; it is now dropped and recorded as `client_aborted`. Closes #171.
- Added built-in detection for more developer credentials: Stripe live secret and restricted keys (`sk_live_`, `rk_live_`), JSON Web Tokens, PEM private key blocks (PKCS#8, RSA, EC and OpenSSH, including a key stored in JSON with escaped newlines), GitLab personal access tokens (`glpat-`), HuggingFace tokens (`hf_`), npm access tokens (`npm_`), SendGrid API keys (`SG.`) and Slack incoming-webhook URLs. Each is redacted whole as a `Secret` at the same 0.99 confidence as the other vendor keys. Closes #179.

- Fixed the CLI doing nothing when installed globally. npm starts a global install through a symlink in the bin directory, and the entry check compared the symlink path with the real file path, so every command exited 0 without output. The check now resolves symlinks. Closes #166.
- Fixed six detector edge cases. An email address at the end of a sentence (`alice@example.com.`) is now found. A secret under a quoted key (`{"api_key": "..."}`) is now found. A password containing `!`, `#`, `$` or similar is taken whole instead of being cut at the first punctuation mark, which left the rest in the clear, a quoted value runs to its closing quote, and an unquoted value in a query string stops at `&` and `?`. A key name containing `token`, `secret`, `password` or `credential` still counts as a secret key wherever the word sits (`refreshtoken`, `clientsecret`), but the weaker words `key`, `pass` and `auth` must be a whole word of the name, so `author`, `monkey` and `compass` no longer count. An `sk-` key must not start in the middle of a word, so `task-force-leader-...` is no longer redacted. `BEARER` in capitals is now recognised. Closes #174.
- Hardening pass over the detectors, the session store and the proxy.

- Session IDs are validated. `--session-id ../../x` could read, overwrite or delete any `.json` file outside the sessions directory. An ID must now be 1 to 255 characters without a path separator, `:`, a Windows-reserved character or a control character. Sessions saved earlier under other names keep working.
- The email and bare-endpoint scans are linear on long hyphen, `+` and `%` runs. 100 KB of hyphens took 10 seconds and 100 KB of hyphenated text 5 seconds.
- The proxy now scrubs `user`, `safety_identifier`, `metadata`, `prediction.content` and `response_format.json_schema` descriptions on OpenAI requests, and `document` blocks, `search_result` blocks and `metadata` on Anthropic requests.
- An allowlisted host no longer exempts a URL with a user name, a password, or a credential-named query or fragment parameter such as `api_key`, `token` or `signature`.
- Credentials in a URL or connection string (`postgres://user:pass@host/db`, `mongodb+srv://`, `redis://`, `amqp://`, `https://user:pass@host`) are redacted as one unit instead of being split or leaking the user name.
- Internationalised email addresses match, and an address includes its compass direction, unit and `, City, ST 12345` tail when a ZIP code is present.
- The proxy warns, as `scrub` does, when the configured locale activates no detector.
- Fixed the **postal-address detector** redacting ordinary prose. Any number followed later in the sentence by a street suffix counted as an address, so `There are 42 things you should consider when walking down the st.` was flagged. The street name between the house number and the suffix is now limited to a few short words and can no longer run over a second number. `10 Downing St` and `1600 Pennsylvania Ave.` still match. Thanks to @RealBhupesh. Closes #86.
- Fixed the proxy ignoring `minConfidence` and `locale` from `config.json`. Findings scored below the configured threshold were still redacted, and locale-scoped rule pack detectors never ran. Both keys now apply from startup and reload with the config file, like `rulePacks` and `urlAllowlist`. Because a threshold leaves low-scoring findings unredacted, the proxy logs the threshold at startup and on reload, adds `suppressed` and `suppressedByCategory` to each `response` event and audit record, and exposes `prompt_scrub_suppressed_total{category}` on `/metrics`. Closes #173.
- Fixed the proxy minting a placeholder that a request already contains literally. A literal `«Email_1»` in one message did not stop another message in the same request, or a later request in the same session, from assigning `«Email_1»` to a real email address, so rehydration restored the wrong value. Literal placeholders are now reserved across every message of a request and for the rest of the session. Closes #169.
- Fixed the proxy forwarding its `x-prompt-scrub-session` header to the upstream provider. The ID is stable for a whole session, so a provider receiving it could link every prompt of that session, and a client that pinned a long-lived ID could be correlated across time and IP addresses. The header now only travels between the client and the proxy. Closes #165.
- Fixed the proxy stalling on event streams that use CRLF line endings. Events were split on `\n\n`, which never appears in `\r\n\r\n`, so a CRLF stream was held back until the upstream finished, and a CR-only stream was never rehydrated. Event boundaries now follow the SSE rules for CRLF, CR and LF, including a CRLF split across two chunks. Events are delivered as they arrive, and output events always use LF. Closes #168.
- Fixed the **proxy** leaking a placeholder in streamed text. A placeholder split across two SSE events (`«Email_` then `1»`) was only restored in tool-call arguments, so `delta.content` and Anthropic `text_delta` reached the client as a literal `«Email_1»`. A trailing partial placeholder in streamed text is now held back and joined to the next fragment, the same way tool-call arguments already were. Closes #167.
- Fixed the proxy logging query strings. With `-v`, every request event printed the full request URL, so a provider that takes its key in the query (`?api-key=...`, `?key=...`) had that key written to `stderr`. Request events now carry the path only, as response events and the audit log already did. The startup line no longer prints credentials or a query string given in `--target`. The proxy also dropped the query string from every request it forwarded, so `?api-version=` on Azure OpenAI, `?key=` on Gemini and `?limit=` on `/v1/models` never reached the provider; the query string is now forwarded. Closes #177.
- Fixed two ways a large or hostile input could stall the scrubber. The email scan was quadratic on a long run of `-`, `+` or `%`: `a@` followed by 40,000 hyphens took about 1.5 seconds and 100,000 took 10. Collision resolution rescanned the whole accepted set for every finding, and the scrubbed text was rebuilt by re-slicing the whole string once per finding, so a document with 10,000 findings took about 1.7 seconds; it now takes under 100 milliseconds, with identical output. Closes #175.
- Fixed a rule pack that fails to load being skipped without a word. A misspelt or uninstalled package in `rulePacks`, or a pack that throws while loading, left its detectors silently inactive, so a prompt was scrubbed with fewer rules than the config promised. `scrub`, `inspect`, `rules list`, `watch` and `proxy` now warn on `stderr`, once per run, naming the pack and the reason, and carry on without it. Closes #176.
- Fixed long API keys being redacted only in part. The `sk-` pattern stopped after 80 characters, so an OpenAI project key (about 164 characters) or an Anthropic key (about 108) kept its tail in the clear. The pattern now matches the whole key. Closes #162.
- Fixed values and categories named like `Object.prototype` members. A detected value such as `constructor`, `toString` or `__proto__` read back an inherited function from the session lookup, so the text was replaced with `function Object() { [native code] }`, nothing was saved to the session map, and the original could not be restored. A category with such a name had its counter and statistics corrupted the same way. Lookups now use `Map`s and the statistics counters ignore inherited names. Closes #170.
- Fixed **UrlDetector** over-capturing trailing markdown punctuation and parentheses. Trailing sentence punctuation (`.`, `,`, `:`, `?`) and unbalanced closing parentheses or brackets are now excluded from URL findings, preventing corruption of surrounding Markdown links and sentence punctuation while preserving balanced parentheses in URL paths. Thanks to @slopggobblercobbler81. Closes #178.

# 1.4.0

- Encrypt local session files at rest. A session file holds the placeholder -> original-value map, which is the most sensitive thing `prompt-scrub` writes to disk, and it sat there as plain JSON protected only by `0600` file permissions - so a stolen laptop, a synced backup or any other process running as the same user got the mappings in the clear. Setting `"encryptionEnabled": true` in the config file now makes every session write an AES-256-GCM envelope with a per-file random salt and IV, a 32-byte key derived through scrypt (`N=16384, r=8, p=1`), and a GCM auth tag that makes tampering detectable rather than silently decodable.

Keys are resolved in a fixed order - the in-process cache, then `PROMPT_SCRUB_KEY`, then an interactive prompt with the input muted - and the prompt refuses to run when stdin or stdout is redirected, so a piped or CI invocation fails with a clear message instead of hanging on a TTY that is not there. Enabling encryption for the first time asks twice and aborts on a mismatch, because a typo at that point would permanently lock the session. Library callers get `getEncryptionKey()`, `setCachedEncryptionKey()`, `getCachedKey()` and `clearCachedEncryptionKey()` exported from the package root, alongside `encryptSession()`, `decryptSession()`, `isEncryptedEnvelope()` and `SessionDecryptionError`. Derived keys are cached per `(passphrase, salt, KDF params)` so `scrub`/`rehydrate` do not pay the deliberately expensive scrypt cost on every read and write, and `clearCachedEncryptionKey()` wipes the passphrase and that derived material together.

`prompt-scrub sessions encrypt [id]` migrates sessions that are already on disk, with `--rekey` to rotate the passphrase over files that are already encrypted. It refuses to run unless `encryptionEnabled` is set, never fabricates a file for a session ID that does not exist, and reports how many sessions it encrypted, skipped and could not find. `sessions list` and `sessions show` ask for a key only when a file they are about to read is actually encrypted, so turning the flag on does not start demanding a passphrase for plaintext sessions, and an undecryptable session in `list` is reported on that row rather than aborting the whole listing.

**Behaviour change:** reading an encrypted session that cannot be decrypted now throws the typed `SessionDecryptionError` - distinguishing "wrong key", "tampered file" and "no key available" - instead of quarantining the file and returning an empty map, which previously looked identical to a session that had simply expired. Silent quarantine is still the behaviour for genuinely unparseable JSON. Writes will not downgrade: once a session file on disk is encrypted, later writes to it stay encrypted even if `encryptionEnabled` is toggled back off, so flipping the flag cannot quietly rewrite a protected map as plaintext. Encryption is off by default and existing plaintext sessions keep working untouched. Thanks to @akramcodez. Closes #94.

# 1.3.0

- Add --json flag to scrub, inspect, and rehydrate CLI commands for machine-readable output in CI/CD pipelines and scripts. Also fixes inspect's placeholder numbering to match actual scrub output (right-to-left replacement with per-value deduplication); inspect text and JSON output now show the same placeholders scrub will produce.
- Add locale-aware detector support: rule packs can declare a `locales` field (BCP-47) so a detector only runs when a matching locale is active, selected via a `locale` config key or a `--locale` flag on `scrub`, `inspect` and `watch` (flag overrides config; matching crosses subtag levels, so `de` serves `de-DE`). A locale-scoped finding takes precedence over the generic built-in of the same category, letting a locale pack replace an English-biased match, but never by covering less text than the finding it displaces, and higher-priority detectors such as `SecretDetector` still win. A malformed `--locale` exits non-zero; a well-formed locale that activates no detector warns on `stderr` instead of silently scrubbing English-only. `locales` from a third-party rule pack is validated at load and dropped when malformed. `rules list` gains `Locales`/`Locale State` columns and a `--locale` preview option. `getActiveDetectors` now also filters custom detectors that declare `locales` - previously the field was ignored and such a detector always ran. Closes #96.
- feat: add `prompt-scrub proxy` — a local HTTP proxy that scrubs outgoing LLM requests (OpenAI `/v1/chat/completions`, Anthropic `/v1/messages`) and rehydrates responses, including streaming Server-Sent Events, transparently. Session continuity is maintained via an `x-prompt-scrub-session` request/response header.

# 1.2.0

- Add a `diff` command that prints a colorized original-vs-scrubbed view (`--side-by-side`, `--context`, `--no-color`) without writing a session.

Inspect table numbering and sanitizing now match scrub when two entities share a category.

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
