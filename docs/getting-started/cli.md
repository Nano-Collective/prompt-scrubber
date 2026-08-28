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
- `-q, --quiet`: Suppress the summary. The `Session ID:` line is still printed, since scripts need it to rehydrate.

### `prompt-scrub rehydrate [file]`
Reads a scrubbed response from `stdin` or a file and prints the rehydrated response to `stdout`.

**Warnings (stderr):**
If the model hallucinates a placeholder that does not exist in the session map (e.g., the model outputs `Secret_2` but only `Secret_1` was scrubbed), the tool passes the string through unchanged to `stdout`, but emits a warning directly to `stderr`.

**Options:**
- `--session-id <id>` (Required): The session ID used during the `scrub` phase to restore original values.

### `prompt-scrub inspect [file]`
Reads a message from `stdin` or a file and prints a human-readable diff of the transformations the scrubber will apply. Also prints a SHA-256 hash of the final byte-stable output for verifying prompt cache deterministic prefix stability.

**Options:**
- `--disable <detectors>`: Comma-separated list of detectors to disable.
- `--hash`: Print *only* the SHA-256 hash for scripting purposes.

### `prompt-scrub diff [file]`
Reads a message from `stdin` or a file and prints a colorized line diff of the original text against what `scrub` would emit. Nothing is written to a session. Red lines are the original PII, green lines are the placeholders.

```bash
echo "Email me at alice@corp.com" | prompt-scrub diff --no-color
```

```
- Email me at alice@corp.com
+ Email me at «Email_1»
```

Colors are on when stdout is a TTY. Pass `--no-color` to pipe the output into a file.

**Options:**
- `--side-by-side`: Two-column layout (`original | scrubbed`).
- `--context <n>`: Unchanged lines kept around each change (default `3`).
- `--no-color`: Disable ANSI colors.
- `--disable <detectors>`: Comma-separated list of detectors to disable.

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

**Platform requirements:**

Watch mode shells out to a small platform helper for clipboard access and notifications. If the required binary is missing, clipboard monitoring fails immediately with an actionable error, and notifications degrade to a single warning on `stderr` rather than failing silently.

| Platform | Clipboard | Notifications |
| --- | --- | --- |
| Windows | `powershell.exe` | `powershell.exe` |
| macOS | `pbpaste` / `pbcopy` | `osascript` |
| Linux | `xclip` | `notify-send` (`libnotify-bin`) |

## Session Management

### `prompt-scrub sessions list`
Lists all known session IDs currently stored on disk along with their file sizes.

### `prompt-scrub sessions show <id>`
Prints the raw JSON contents of a session map for inspection or manual editing.

### `prompt-scrub sessions rm <id>`
Deletes a session map from the disk permanently. Use the `--all` option to delete all sessions.

### `prompt-scrub sessions gc`
Manually cleans up expired sessions based on the `sessionTtlDays` configuration. (By default, expired sessions are automatically pruned when you run `scrub` or `sessions list`.)

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
  "sessionTtlDays": 7
}
```

- `rulePacks`: npm package names to load extra detectors from. See [Authoring Rule Packs](../features/authoring-rule-packs.md).
- `urlAllowlist`: hostnames the `UrlDetector` passes through unchanged. Subdomains are implicitly allowed.
- `sessionTtlDays`: number of days after which inactive sessions are automatically garbage collected. Default is 7.

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
  ]
}
```

Entries that do not match the schema are reported on `stderr` and the command exits with code `1`, so it can be used as a config check in scripts. Invalid entries are ignored at runtime rather than failing the scrub:

```bash
$ prompt-scrub config show
Config file: /home/alice/.config/prompt-scrub/config.json
  error: Unknown key "rulePaks". Supported keys: rulePacks, urlAllowlist.
{
  "rulePacks": [],
  "urlAllowlist": []
}
Invalid entries are ignored at runtime.
```

## Utility

### `prompt-scrub --version`
Prints the current version of the CLI.

### `prompt-scrub --help`
Prints standard help documentation and available commands.
