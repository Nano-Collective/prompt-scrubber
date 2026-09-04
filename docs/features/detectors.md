---
title: "Detector System"
description: "How the pluggable detector system finds sensitive information"
sidebar_order: 1
---

# Detector System

The detector system is responsible for scanning input text, identifying sensitive information, and proposing placeholder prefixes (from which exact placeholders are later derived).

## Architecture

Detectors are pluggable functions that conform to the `Detector` interface. They take in the raw text and return a list of `Finding` objects.

```typescript
export interface Finding {
  category: string; // e.g., 'Email', 'Phone', 'Secret'
  span: [number, number]; // [startIndex, endIndex]
  value: string; // The original matched string
  placeholderPrefix: string; // The prefix for the placeholder (e.g., 'Email')
  confidence?: number; // How certain this match is, 0.0-1.0
  method?: string; // How the match was made, e.g. 'exact-pattern'
}

export interface Detector {
  name: string;
  detect(text: string): Finding[];
}
```

> **Note on the `Finding` Interface:** 
> The original whitepaper conceptualizes detectors as returning `{ category, span, replacement }`. However, the exact placeholder (e.g., `Email_2` instead of `Email_1`) cannot be known at detect time because it depends on the state of the active `SessionManager`. 
> 
> To keep detectors as pure functions, the `replacement` computation is deferred to the core pipeline. Detectors instead return the matched `value` and a `placeholderPrefix`, which the session manager uses to generate the final replacement string.

## Built-in Detectors

- `EmailDetector`: Detects RFC 5322 shaped email addresses.
- `PhoneDetector`: Detects international and US-shaped phone numbers.
- `UrlDetector`: Detects full URLs and bare API endpoints. Can be configured to pass-through trusted hosts via `urlAllowlist` in configuration or `--url-allowlist` in the CLI. Subdomains of allowlisted hosts are implicitly trusted.
- `PathDetector`: Detects absolute paths and home directories.
- `SecretDetector`: Detects high-entropy strings, API keys, and tokens.
- `AddressDetector`: Detects unambiguous postal addresses (e.g., street shapes).

### Opt-in Detectors (Off by Default)

- `NameDetector`: Detects proper nouns (capitalized words). Because proper-noun detection has a high risk of false positives, this detector is **disabled by default**. It can be enabled via the API or CLI. It also features a "strict mode" that leverages an allowlist to skip common countries, languages, and products to minimize false positives.
- `CodeTellDetector`: Detects user-enumerated private identifiers and variables. It is **disabled by default** because the false-positive risk of supplying overly generic terms on code payloads is very high. It acts as a no-op unless explicitly configured with a list of terms.

## Confidence & Tiered Detection

Not every match is equally certain. A vendor-prefixed API key is recognised by
an exact pattern and is as close to certain as pattern matching gets; a
capitalised word is only a guess at a name. Every built-in finding therefore
carries a `confidence` between 0.0 and 1.0 and a `method` naming the rule that
produced it.

| Detector | Match | Confidence | Method |
| --- | --- | --- | --- |
| `SecretDetector` | Vendor key prefix (`sk-`, `ghp_`, `AKIA`, ...) | 0.99 | `exact-pattern` |
| `SecretDetector` | `Bearer` token | 0.90 | `exact-pattern` |
| `SecretDetector` | Suggestive key name (`API_KEY=...`) | 0.70 | `key-name` |
| `SecretDetector` | High-entropy string | 0.60 | `entropy` |
| `EmailDetector` | Any match | 0.95 | `exact-pattern` |
| `UrlDetector` | Scheme-qualified URL | 0.95 | `exact-pattern` |
| `UrlDetector` | Bare `host/path` | 0.70 | `heuristic` |
| `PathDetector` | `~/...` or `C:\...` | 0.90 | `structural` |
| `PathDetector` | Bare absolute path | 0.80 | `structural` |
| `PhoneDetector` | E.164 or `(555) 123-4567` | 0.90 | `structural` |
| `PhoneDetector` | Bare `555-123-4567` | 0.80 | `structural` |
| `AddressDetector` | Any match | 0.70 | `heuristic` |
| `NameDetector` | Any match (0.60 in strict mode) | 0.50 | `heuristic` |
| `CodeTellDetector` | Any match | 0.95 | `user-defined` |

`confidence` and `method` are optional on the `Detector` interface so that rule
packs written against the original interface keep working. A finding that omits
them is scored at `DEFAULT_CONFIDENCE` (0.5) with the method `unspecified`.

### Filtering by confidence

Pass `minConfidence` in `ScrubOptions` (or `--min-confidence` on the CLI, or
`minConfidence` in the config file) to discard everything scored below a
threshold. The default is `0`, so nothing is filtered unless you opt in.

```bash
# Only scrub what the detectors are confident about
prompt-scrub scrub --min-confidence 0.9 prompt.txt
```

Filtering happens **before** collision resolution, so a discarded low-confidence
finding can never mask a higher-confidence one that overlaps it.

Run `inspect` first: it prints the score and method of every entity, so you can
see what a threshold would drop before you commit to it.

### A threshold always says what it dropped

Under-redaction is the dangerous direction, so a filtered run never goes quiet.
Whatever the threshold discarded is reported alongside what was scrubbed:

```bash
$ echo "mail alice@example.com and call 555-123-4567" | prompt-scrub scrub --min-confidence 0.9
mail «Email_1» and call 555-123-4567
Scrubbed: 1 entity (1 Email); 1 suppressed below --min-confidence 0.9 (1 Phone)
```

This is reported even when nothing survived the threshold — that is precisely
the case where the output is byte-identical to a prompt that never contained
anything sensitive:

```bash
$ echo "call 555-123-4567" | prompt-scrub scrub --min-confidence 0.95
call 555-123-4567
Scrubbed: 0 entities; 1 suppressed below --min-confidence 0.95 (1 Phone)
```

`inspect` lists the dropped entities individually, and `watch` logs the same
notice. A dropped finding whose span some surviving finding still redacts is
not counted: it was not left in the clear, and a notice that fires on every
overlapping detector would quickly be ignored.

Pass `-q`/`--quiet` to `scrub` to suppress the summary entirely.

## Priority & Collision System

When multiple detectors flag overlapping spans, a collision resolution system determines which finding wins.

Priority is implicitly handled by a defined order of precedence:
1. `SecretDetector` (highest priority - missing a secret is dangerous)
2. `EmailDetector`
3. `UrlDetector`
4. `PathDetector`
5. `PhoneDetector`
6. `AddressDetector`
7. `NameDetector`
8. `CodeTellDetector`

If `SecretDetector` and `UrlDetector` match the same string (e.g., a URL with a token), `SecretDetector` wins.

## Registration System

By default, the core scrub function runs the built-in detectors in priority order. You can optionally configure detectors via `ScrubOptions` in the API, or through the CLI:

- **Disable defaults**: Pass `disabledDetectors` (or `--disable` via CLI) to turn off specific built-ins.
- **Enable opt-ins**: Pass `enabledDetectors` (or `--enable` via CLI) to activate off-by-default detectors like `NameDetector`.
- **Strict Mode**: Pass `strictNameDetector: true` (or `--strict-name` via CLI) to reduce false positives for the `NameDetector`.
- **Code Tell**: Pass `codeTellTerms` (or `--code-tell-terms` via CLI) as an array of identifiers to enable and configure the `CodeTellDetector`.
- **Confidence floor**: Pass `minConfidence` (or `--min-confidence` via CLI) to discard findings scored below a threshold.

### Custom Detectors (Programmatic)

Custom detectors can be passed in during the execution of the library by providing them in the `customDetectors` array in the `ScrubOptions` (see `src/types/index.ts`). This effectively overrides or appends to the default list.

### Rule Packs (External Plugins)

prompt-scrubber supports distributing rule packs as standalone npm packages. A rule pack is just a normal npm package that exports an array of `Detector` objects. 

To use a rule pack:
1. Install it via npm: `npm install some-rule-pack`
2. Declare it in your configuration file. Run `prompt-scrub init` to create one, then add the package name to `rulePacks`:

```json
{
  "rulePacks": ["some-rule-pack"],
  "urlAllowlist": [],
  "minConfidence": 0
}
```

Run `prompt-scrub config show` to confirm the tool picked it up.

Once declared, the CLI will automatically discover, load, and merge these detectors into the active set on startup. They participate natively in collision resolution and can be inspected via `prompt-scrub rules list`.

For a guide on how to author your own rule pack, see [Authoring Rule Packs](./authoring-rule-packs.md).

## CLI Rules Command

You can inspect the active detector set using the `rules` command:

```bash
npx prompt-scrub rules list
```

This will print a list of all available detectors, indicating their source (e.g., `built-in`) and their default state (`on` or `off`). This allows you to verify which detectors will run by default before you pass any additional flags like `--disable` or `--enable`.
