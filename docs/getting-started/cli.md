---
title: "CLI Reference"
description: "Using the prompt-scrub command-line tool"
sidebar_order: 1
---

# CLI Reference

The `prompt-scrub` package provides a command-line interface for manual inspection, scripting, and pipeline integration.

## Core Commands

### `prompt-scrub scrub [file]`
Reads a message from `stdin` or a file and prints the scrubbed message to `stdout`. The session ID and a summary of what was replaced are printed to `stderr`, so `stdout` stays clean for piping.

```bash
echo "Mail alice@acme.com about sk-abcdefghijklmnopqrstuvwxyz" | prompt-scrub scrub
```

```
Mail «Email_1» about «Secret_1»
Session ID: 6f1c2b90-0d3a-4f8e-9a21-2b7c1e4d5a63
Scrubbed: 2 entities (1 Email, 1 Secret)
```

The summary counts replacements, not unique values: a value that appears three times counts three times, even though all three collapse onto the same placeholder. Reusing a session with `--session-id` does not carry counts over — the summary always describes the current run only. When nothing is detected the summary reads `Scrubbed: 0 entities`.

**Options:**
- `--session-id <id>`: Reuse an existing session map. If omitted, a new UUID is generated.
- `--disable <detectors>`: Comma-separated list of detectors to disable (e.g. `EmailDetector,PhoneDetector`).
- `--locale <locale>`: BCP-47 tag (e.g. `de-DE`) that activates detectors scoped to that locale. Overrides `locale` in the configuration file. A malformed tag exits `1`; a well-formed tag that activates no detector warns on `stderr`, so a missing rule pack is never mistaken for a completed locale scrub.
- `--min-confidence <value>`: Discard findings scored below this confidence (`0`-`1`). Defaults to the configured `minConfidence`, or `0` (keep everything). Whatever the threshold discards is named in the summary, so a filtered run never quietly under-redacts. See [Confidence & Tiered Detection](../features/detectors.md#confidence--tiered-detection).
- `-q, --quiet`: Suppress the summary. The `Session ID:` line is still printed, since scripts need it to rehydrate. A `--min-confidence` suppression notice is still printed too — `-q` is exactly the automated-workflow path that flag targets, so it must not be what hides what got dropped.
- `--json`: Output result as structured JSON instead of text.
- `--include-session-map`: Include `sessionMap` in JSON output (requires `--json`; contains sensitive values in plaintext — with this flag, raw values are written to stdout and will end up in CI logs).

### `prompt-scrub rehydrate [file]`
Reads a scrubbed response from `stdin` or a file and prints the rehydrated response to `stdout`.

**Warnings (stderr):**
If the model hallucinates a placeholder that does not exist in the session map (e.g., the model outputs `Secret_2` but only `Secret_1` was scrubbed), the tool passes the string through unchanged to `stdout`, but emits a warning directly to `stderr`.

**Options:**
- `--session-id <id>` (Required): The session ID used during the `scrub` phase to restore original values.
- `--json`: Output result as structured JSON instead of text.

### `prompt-scrub inspect [file]`
Reads a message from `stdin` or a file and prints a table of detected entities (category, value, placeholder, span). Also prints a SHA-256 hash of the final byte-stable output for verifying prompt cache deterministic prefix stability.

Every entity is listed with the confidence the detector assigned it and the method
that produced the match, so you can see what a `--min-confidence` threshold would
drop before you commit to one:

```bash
$ echo "My email is alice@acme.com and I work at /Users/alice/projects." | prompt-scrub inspect
Detected entities:
  [Email]    alice@acme.com                   → «Email_1»  (chars 12-26, confidence 0.95 exact-pattern)
  [Path]     /Users/alice/projects.           → «Path_1»   (chars 41-63, confidence 0.80 structural)
```

**Options:**
- `--disable <detectors>`: Comma-separated list of detectors to disable.
- `--enable <detectors>`: Comma-separated list of off-by-default detectors to enable (e.g. `NameDetector`).
- `--strict-name`: Enable strict allowlisting for `NameDetector`.
- `--code-tell-terms <terms>`: Comma-separated list of private identifiers to detect.
- `--url-allowlist <hosts>`: Comma-separated list of hostnames to pass through.
- `--locale <locale>`: BCP-47 tag that activates detectors scoped to that locale.
- `--min-confidence <value>`: Hide findings scored below this confidence (`0`-`1`). Anything dropped is listed under a `Suppressed below --min-confidence <value>:` heading rather than silently disappearing. The printed hash reflects the filtered output, matching what `scrub` would produce at the same threshold.
- `--hash`: Print *only* the SHA-256 hash for scripting purposes.
- `--json`: Output result as structured JSON instead of text.

### `prompt-scrub diff [file]`
Reads a message from `stdin` or a file and prints a colorized line diff of the original text against what `scrub` would emit. Nothing is written to a session. Red lines are the original PII, green lines are the placeholders.

```bash
echo "Email me at alice@corp.com" | prompt-scrub diff --no-color
```

```
- Email me at alice@corp.com
+ Email me at «Email_1»
```

Colors are on when stdout is a TTY. Pass `--no-color` or set `NO_COLOR` to pipe the output into a file.

**Options:**
- `--side-by-side`: Two-column layout (`original | scrubbed`). Long lines wrap; they are not truncated.
- `--context <n>`: Unchanged lines kept around each change (default `3`). Must be a non-negative integer.
- `--no-color`: Disable ANSI colors.
- `--disable <detectors>`: Comma-separated list of detectors to disable.
- `--enable <detectors>`: Comma-separated list of off-by-default detectors to enable (e.g. `NameDetector`).
- `--strict-name`: Enable strict allowlisting for `NameDetector`.
- `--code-tell-terms <terms>`: Comma-separated list of private identifiers to detect.
- `--url-allowlist <hosts>`: Comma-separated list of hostnames to pass through.

## Watch Mode

### `prompt-scrub watch`
Continuously monitors your system clipboard and/or one or more files, scrubbing sensitive content in place as soon as it appears. This is aimed at the copy-paste workflow: copy a prompt containing real data, and it is scrubbed before you paste it into a web-based LLM.

At least one of `--clipboard` or `--file` is required. A desktop notification is emitted for each scrub, summarising what was replaced.

```bash
# Scrub the clipboard continuously
prompt-scrub watch --clipboard

# Scrub two files, checking twice a second
prompt-scrub watch --file prompt.txt notes.md --interval 500

# See what would change without writing anything
prompt-scrub watch --file prompt.txt --dry-run --once
```

A single session is used for the whole run, so placeholders keep counting up across ticks and two different values can never share one token. The session ID is printed on start-up (`[watch] Session ID: <id>`) - pass it to `prompt-scrub rehydrate --session-id <id>` to restore the originals. Use `--session-id` to keep watching into an existing session instead.

Press `Ctrl-C` to stop watching; the poll loop is cleared and the process exits cleanly.

**Options:**
- `-c, --clipboard`: Monitor the system clipboard.
- `-f, --file <files...>`: One or more files to monitor and rewrite in place.
- `-i, --interval <ms>`: Polling interval in milliseconds (default `1000`).
- `--once`: Run a single check pass and exit. Useful in scripts and CI.
- `--dry-run`: Report what would be scrubbed without writing the clipboard or any file.
- `--backup`: Write `<file>.bak` containing the pre-scrub content before overwriting a watched file.
- `--session-id <id>`: Reuse an existing session map so placeholders stay stable across runs.
- `--disable <detectors>`: Comma-separated list of detectors to skip.
- `--enable <detectors>`: Comma-separated list of off-by-default detectors to enable.
- `--strict-name`: Enable strict allowlisting for `NameDetector`.
- `--code-tell-terms <terms>`: Comma-separated list of private identifiers to detect.
- `--url-allowlist <hosts>`: Comma-separated list of hostnames to pass through.
- `--locale <locale>`: BCP-47 tag that activates detectors scoped to that locale, for this run only. Overrides `locale` in the configuration file. Validated once before the poll loop starts.
- `--min-confidence <value>`: Discard findings scored below this confidence (`0`-`1`). Anything dropped is logged, including when it means the clipboard or file is left untouched.

**Platform requirements:**

Watch mode shells out to a small platform helper for clipboard access and notifications. If the required binary is missing, clipboard monitoring fails immediately with an actionable error, and notifications degrade to a single warning on `stderr` rather than failing silently.

| Platform | Clipboard | Notifications |
| --- | --- | --- |
| Windows | `powershell.exe` | `powershell.exe` |
| macOS | `pbpaste` / `pbcopy` | `osascript` |
| Linux | `xclip` | `notify-send` (`libnotify-bin`) |

## Proxy Mode

### `prompt-scrub proxy`

Runs a local HTTP proxy that intercepts LLM API traffic and rewrites PII in-flight. Point any SDK at the proxy instead of the upstream API and every chat completion (streaming or otherwise) is scrubbed on the way out and rehydrated on the way back, transparently.

```bash
# Scrub + rehydrate OpenAI traffic on localhost:8080
prompt-scrub proxy --target https://api.openai.com --port 8080 &

# Now route your SDK through the proxy. Both work:
export OPENAI_BASE_URL=http://localhost:8080/v1
# or
# point your HTTP client at http://localhost:8080 and add /v1 to your path
```

The proxy recognises two providers by URL shape:

| Path pattern | Provider |
| --- | --- |
| `…/v1/chat/completions` | OpenAI |
| `…/v1/messages` | Anthropic |

Anything that does not match a known shape (e.g. `GET /v1/models`, `POST /v1/embeddings`) is forwarded byte-for-byte without modification. This is the safe default: enabling a new vendor is additive.

**Scrubbed fields.** Every field of a recognised body that carries free text:

| | OpenAI | Anthropic |
| --- | --- | --- |
| Message content | `messages[].content` (string or `text` parts) | `messages[].content` (string or `text` blocks) |
| System prompt | the `role: "system"` message | top-level `system` (string or `text` blocks) |
| Tool call arguments | `messages[].tool_calls[].function.arguments` | `tool_use.input` |
| Tool results | the `role: "tool"` message | `tool_result` blocks, including `text` blocks nested inside them |
| Tool definitions | `tools[].function.description` / `tools[].custom.description`, plus `description` fields inside `parameters` | `tools[].description`, plus `description` fields inside `input_schema` |
| Deprecated function calling | `messages[].function_call.arguments` and `functions[].description` | — |

Tool arguments are JSON encoded as a string, so they are parsed, scrubbed value by value and re-serialised: argument *keys* and the JSON structure are preserved exactly.

Messages are never dropped. An entry the proxy does not recognise — an assistant turn that carries only `tool_calls`, a block type a vendor adds tomorrow — is forwarded unchanged at its original position in `messages[]`.

**Never scrubbed, by design:** tool names, tool-call ids, JSON-schema property keys and `enum` values. The model has to reproduce those verbatim for the client's own dispatch to work, so a placeholder there would break the call rather than protect anything — keep PII out of tool names and enums.

Responses are rehydrated in the same places as requests: message content, `tool_calls[].function.arguments` and `tool_use.input`. The client executes those tool calls on its own machine, so they are handed back with the real values in them.

**Session continuity:** the proxy threads a session ID through every request via the `x-prompt-scrub-session` header. When the client sends the header back on a follow-up call, the same placeholder map is reused, so `«Email_1»` stays `«Email_1»` across turns. If the client does not send the header, the proxy generates a UUID and echoes it in the response so the client can pin it.

**Streaming:** Server-Sent Events (SSE) are rehydrated incrementally, and a placeholder can be split in two different ways. A *chunk* boundary can fall anywhere, so the proxy buffers bytes that do not yet form a complete event. An *event* boundary is the interesting one: vendors emit roughly one token per event, so `«Email_1»` genuinely arrives as `«Email_` then `1»` in the next event. For streamed tool-call arguments (`delta.tool_calls[].function.arguments`, `input_json_delta.partial_json`) the proxy holds the trailing partial placeholder back and prepends it to the next fragment of that same call, so what the client reassembles carries the real value. `data: [DONE]` sentinels and non-JSON payloads pass through untouched.

**Headers:** the proxy strips hop-by-hop headers per RFC 7230 (`connection`, `keep-alive`, `transfer-encoding`, `upgrade`, `host`, etc.) and rewrites `host` to the upstream value. Authentication headers (`authorization`, `x-api-key`, etc.) are forwarded as-is.

**Garbage collection:** on startup, expired sessions are pruned according to `sessionTtlDays`. Pass `--no-gc` to skip this.

**Options:**
- `--target <url>` (required): Upstream base URL, e.g. `https://api.openai.com` or `https://api.anthropic.com`.
- `--port <port>`: Local port (default `8080`). Use `0` to bind a random free port.
- `--host <host>`: Local interface to bind (default `127.0.0.1`).
- `--disable <detectors>`, `--enable <detectors>`, `--strict-name`, `--code-tell-terms`, `--url-allowlist`: Same scrubber options as the `scrub` command.
- `-v, --verbose`: Log a one-line summary of every proxied request to `stderr` (including the scrubbed/rehydrated counts and session ID).
- `--no-gc`: Skip the startup session-garbage-collection pass.

**Limitations:**

- Request bodies larger than 10 MB are rejected with `413 Payload Too Large`. Tune with `maxBodyBytes` on the programmatic `ProxyOptions`.
- In streamed *text* (`delta.content`, `text_delta`), a placeholder split across two separate SSE events is forwarded as-is: the reader sees `«Email_1»` instead of the value, and nothing is corrupted. Streamed tool-call arguments do not have this gap, because code acts on them — see **Streaming** above.
- A value nested deeper than 64 levels inside tool arguments, a tool schema, or a chain of `tool_result` blocks is forwarded unscrubbed. The cap keeps a hostile body from exhausting the stack; nothing legitimate nests that deep.
- Responses that arrive gzipped are forwarded uncompressed (we strip `accept-encoding` on the outbound hop). Upstreams that re-add gzip mid-flight are forwarded unchanged.
- The proxy does not perform TLS termination for the inbound hop — terminate TLS at a reverse proxy if you need to expose it on a network interface. The default `127.0.0.1` binding is loopback-only.
- The proxy is a development tool, not a hardened gateway. Run it on a trusted host.

## Session Management

### `prompt-scrub sessions list`
Lists all known session IDs currently stored on disk along with their file sizes.

### `prompt-scrub sessions show <id>`
Prints the raw JSON contents of a session map for inspection or manual editing.

### `prompt-scrub sessions rm <id>`
Deletes a session map from the disk permanently. Use the `--all` option to delete all sessions.

### `prompt-scrub sessions gc`
Manually cleans up expired sessions based on the `sessionTtlDays` configuration. (By default, expired sessions are automatically pruned when you run `scrub` or `sessions list`.)

### `prompt-scrub sessions encrypt [id]`
Re-encrypts existing session files using the active encryption key. Pass a session ID to encrypt a single session; omit it to encrypt every session on disk. Requires `encryptionEnabled: true` in the config and `PROMPT_SCRUB_KEY` in the environment (or an interactive TTY prompt). Sessions that are already encrypted are skipped. Pass `--rekey` to also rewrite already-encrypted sessions — useful when rotating the passphrase. Note that re-keying requires the OLD passphrase to still be resolvable; the command refuses to silently overwrite a file it cannot decrypt.

## Encryption at Rest

Session files map placeholders like `«Secret_1»` back to your real secrets. Without encryption they are plain JSON on disk, so a stolen laptop or any process running under your account can read every value you have ever scrubbed.

Enable encryption in your config:

```json
// ~/.config/prompt-scrub/config.json
{ "encryptionEnabled": true }
```

Then supply the passphrase via the `PROMPT_SCRUB_KEY` environment variable when invoking `scrub`, `rehydrate`, or `sessions`:

```bash
# Avoid inline `PROMPT_SCRUB_KEY=…` — it ends up in shell history.
# Either set it from your secret manager or read it interactively.
export PROMPT_SCRUB_KEY
read -rs PROMPT_SCRUB_KEY
echo "sk-1234567890abcdefghij" | prompt-scrub scrub
```

If `PROMPT_SCRUB_KEY` is unset and `stdin` is a TTY, `prompt-scrub` prompts for the passphrase with input muted. In non-interactive contexts (CI, scripts reading from a pipe) it fails fast with a clear error rather than blocking on stdin.

The CLI also resolves the passphrase when an existing session is encrypted, even if `encryptionEnabled` was toggled off after the file was written — so a future `scrub --session-id <id>` on an encrypted session still requires the key. This prevents silent downgrades where toggling the config flag rewrote an encrypted session in plaintext.

To migrate plaintext sessions that exist on disk from before you enabled encryption:

```bash
PROMPT_SCRUB_KEY=… prompt-scrub sessions encrypt
```

Library users can inject a key without going through the env var or TTY prompt:

```typescript
import { scrub, setCachedEncryptionKey } from '@nanocollective/prompt-scrub';
setCachedEncryptionKey(process.env.MY_APP_KEY ?? '');
const { scrubbedContent } = scrub({ content: 'My key is sk-12345' });
```

The crypto envelope is `version: 1`, `algorithm: aes-256-gcm`, `kdf: scrypt`, with a per-file random 16-byte salt and 12-byte IV. Derived keys are cached by salt within a single process so listing many encrypted sessions does not re-derive every key.

**Threat model boundaries.** Encryption protects the session file at rest on disk. It does NOT protect secrets while they are in memory, and it does NOT protect the output of commands like `sessions show` — running `prompt-scrub sessions show <id>` on an encrypted session prints the decrypted placeholders to stdout. Treat the decrypted map as ephemeral.

**Re-keying.** Pass `--rekey` to `sessions encrypt` to rewrite already-encrypted sessions. Note that re-keying only works when the OLD passphrase is still resolvable — the command refuses to silently overwrite a file it cannot decrypt.

**Environment-variable caveats.** `PROMPT_SCRUB_KEY` is the simplest way to script encryption, but on Linux the value is also readable via `/proc/<pid>/environ` to any process running as your user, and inline `PROMPT_SCRUB_KEY=…` invocations leave the passphrase in your shell history. Prefer `read -rs` or a secret-manager export.

## Configuration

### `prompt-scrub init`
Creates a configuration file with the default (empty) schema at the OS config path (`~/.config/prompt-scrub/config.json` on Linux, `~/Library/Application Support/prompt-scrub/config.json` on macOS, `%APPDATA%\prompt-scrub\config.json` on Windows). Parent directories are created if needed. Set `PROMPT_SCRUB_CONFIG_DIR` to relocate the config directory on any platform.

```bash
$ prompt-scrub init
Created config file at /home/alice/.config/prompt-scrub/config.json
```

The generated file documents the supported schema:

```json
{
  "rulePacks": [],
  "urlAllowlist": [],
  "minConfidence": 0,
  "sessionTtlDays": 7,
  "locale": "",
  "encryptionEnabled": false
}
```

- `rulePacks`: npm package names to load extra detectors from. See [Authoring Rule Packs](../features/authoring-rule-packs.md).
- `urlAllowlist`: hostnames the `UrlDetector` passes through unchanged. Subdomains are implicitly allowed.
- `minConfidence`: findings scored below this threshold are discarded. `0` keeps everything; `--min-confidence` overrides it per run.
- `sessionTtlDays`: number of days after which inactive sessions are automatically garbage collected. Default is 7.
- `locale`: BCP-47 tag (e.g. `de-DE`) enabling locale-scoped detectors. Empty means English/locale-agnostic detection only.
- `encryptionEnabled`: when `true`, every session write is encrypted with AES-256-GCM using a passphrase read from `PROMPT_SCRUB_KEY` (or an interactive TTY prompt). See [Encryption at Rest](#encryption-at-rest) above.

Fails if a config file already exists.

**Options:**
- `--force`: Overwrite the existing configuration file.

### `prompt-scrub config show`
Prints the active configuration as JSON on `stdout`, and the path it was read from on `stderr`. If no config file exists, the defaults are printed instead.

```bash
$ prompt-scrub config show
Config file: /home/alice/.config/prompt-scrub/config.json
{
  "rulePacks": [
    "prompt-scrub-projectx"
  ],
  "urlAllowlist": [
    "example.com"
  ],
  "minConfidence": 0.8,
  "sessionTtlDays": 7,
  "locale": "de-DE",
  "encryptionEnabled": false
}
```

Entries that do not match the schema are reported on `stderr` and the command exits with code `1`, so it can be used as a config check in scripts. Invalid entries are ignored at runtime rather than failing the scrub:

```bash
$ prompt-scrub config show
Config file: /home/alice/.config/prompt-scrub/config.json
  error: Unknown key "rulePaks". Supported keys: rulePacks, urlAllowlist, minConfidence, sessionTtlDays, locale, encryptionEnabled.
{
  "rulePacks": [],
  "urlAllowlist": [],
  "minConfidence": 0,
  "sessionTtlDays": 7,
  "locale": "",
  "encryptionEnabled": false
}
Invalid entries are ignored at runtime.
```

## Utility

### `prompt-scrub --version`
Prints the current version of the CLI.

### `prompt-scrub --help`
Prints standard help documentation and available commands.

## JSON Output Formats
All three commands emit their primary payload under `content`.

### scrub --json
```json
{
  "content": "Email «Email_1» and «Email_2»",
  "sessionId": "uuid-here",
  "stats": {
    "totalEntities": 2,
    "byCategory": { "Email": 2 }
  }
}
```
`sessionId` is present only when something was scrubbed and a session was persisted — it is omitted (not empty) otherwise. `sessionMap` appears only when `--include-session-map` is passed, and contains the original sensitive values in plaintext: with that flag, raw PII is written to stdout and will end up in CI logs.

### inspect --json
```json
{
  "entities": [
    {
      "category": "Email",
      "value": "alice@example.com",
      "placeholder": "«Email_1»",
      "span": [0, 20],
      "confidence": 1.0,
      "method": "regex"
    }
  ],
  "suppressed": [],
  "hash": "sha256-hex-here"
}
```
### rehydrate --json
```json
{
  "content": "Email alice@example.com and bob@example.com",
  "sessionId": "uuid-here",
  "warnings": []
}
```

`warnings` is returned by `rehydrate` only, since it is the only command that can produce them.

### Errors (stdin/file read failures only)

If a file cannot be read or stdin is unavailable, commands running with `--json` print a JSON error envelope to **stderr** and exit with code `1`. Success JSON is written to **stdout**, so `prompt-scrub scrub --json | jq` never sees error text mixed into the pipe.

```json
{ "error": "message describing what went wrong" }
```
