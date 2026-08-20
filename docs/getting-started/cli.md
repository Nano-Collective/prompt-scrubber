---
title: "CLI Reference"
description: "Using the prompt-scrub command-line tool"
sidebar_order: 1
---

# CLI Reference

The `prompt-scrub` package provides a command-line interface for manual inspection, scripting, and pipeline integration. 

## Core Commands

### `prompt-scrub scrub [file]`
Reads a message from `stdin` or a file and prints the scrubbed message to `stdout`. The session ID is printed to `stderr`.

**Options:**
- `--session-id <id>`: Reuse an existing session map. If omitted, a new UUID is generated.
- `--disable <detectors>`: Comma-separated list of detectors to disable (e.g. `EmailDetector,PhoneDetector`).
- `--locale <locale>`: BCP-47 tag (e.g. `de-DE`) that activates detectors scoped to that locale. Overrides `locale` in the configuration file.

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
- `--locale <locale>`: BCP-47 tag that activates detectors scoped to that locale.
- `--hash`: Print *only* the SHA-256 hash for scripting purposes.

## Session Management

### `prompt-scrub sessions list`
Lists all known session IDs currently stored on disk along with their file sizes.

### `prompt-scrub sessions show <id>`
Prints the raw JSON contents of a session map for inspection or manual editing.

### `prompt-scrub sessions rm <id>`
Deletes a session map from the disk permanently.

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
  "locale": ""
}
```

- `rulePacks`: npm package names to load extra detectors from. See [Authoring Rule Packs](../features/authoring-rule-packs.md).
- `urlAllowlist`: hostnames the `UrlDetector` passes through unchanged. Subdomains are implicitly allowed.
- `locale`: BCP-47 tag (e.g. `de-DE`) enabling locale-scoped detectors. Empty means English/locale-agnostic detection only.

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
  "locale": "de-DE"
}
```

Entries that do not match the schema are reported on `stderr` and the command exits with code `1`, so it can be used as a config check in scripts. Invalid entries are ignored at runtime rather than failing the scrub:

```bash
$ prompt-scrub config show
Config file: /home/alice/.config/prompt-scrub/config.json
  error: Unknown key "rulePaks". Supported keys: rulePacks, urlAllowlist, locale.
{
  "rulePacks": [],
  "urlAllowlist": [],
  "locale": ""
}
Invalid entries are ignored at runtime.
```

## Utility

### `prompt-scrub --version`
Prints the current version of the CLI.

### `prompt-scrub --help`
Prints standard help documentation and available commands.
