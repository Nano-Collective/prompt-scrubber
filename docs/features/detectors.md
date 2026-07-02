---
title: "Detector System"
description: "How the pluggable detector system finds sensitive information"
sidebar_order: 1
---

# Detector System

The detector system is responsible for scanning input text, identifying sensitive information, and proposing replacements (placeholders).

## Architecture

Detectors are pluggable functions that conform to the `Detector` interface. They take in the raw text and return a list of `Finding` objects.

```typescript
export interface Finding {
  category: string; // e.g., 'Email', 'Phone', 'Secret'
  span: [number, number]; // [startIndex, endIndex]
  value: string; // The original matched string
  placeholderPrefix: string; // The prefix for the placeholder (e.g., 'Email')
}

export interface Detector {
  name: string;
  detect(text: string): Finding[];
}
```

## Built-in Detectors

- `EmailDetector`: Detects RFC 5322 shaped email addresses.
- `PhoneDetector`: Detects international and US-shaped phone numbers.
- `UrlDetector`: Detects full URLs (with allowlist support).
- `PathDetector`: Detects absolute paths and home directories.
- `SecretDetector`: Detects high-entropy strings, API keys, and tokens.
- `AddressDetector`: Detects unambiguous postal addresses (e.g., street shapes).

### Opt-in Detectors (Off by Default)

- `NameDetector`: Detects proper nouns (capitalized words). Because proper-noun detection has a high risk of false positives, this detector is **disabled by default**. It can be enabled via the API or CLI. It also features a "strict mode" that leverages an allowlist to skip common countries, languages, and products to minimize false positives.
- `CodeTellDetector`: Detects user-enumerated private identifiers and variables. It is **disabled by default** because the false-positive risk of supplying overly generic terms on code payloads is very high. It acts as a no-op unless explicitly configured with a list of terms.

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

### Custom Detectors

Custom detectors can be passed in during the execution of the library by providing them in the `customDetectors` array in the `ScrubOptions` (see `src/types/index.ts`). This effectively overrides or appends to the default list.

*Note: In v1, there is no rule-pack installer or rules CLI surface. All custom detectors must be configured via the library API.*
