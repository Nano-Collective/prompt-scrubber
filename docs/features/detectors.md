---
title: "Detector System"
description: "Documentation for Detector System"
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

## Priority & Collision System

When multiple detectors flag overlapping spans, a collision resolution system determines which finding wins.

Priority is implicitly handled by a defined order of precedence:
1. `SecretDetector` (highest priority - missing a secret is dangerous)
2. `EmailDetector`
3. `UrlDetector`
4. `PathDetector`
5. `PhoneDetector`

If `SecretDetector` and `UrlDetector` match the same string (e.g., a URL with a token), `SecretDetector` wins.

## Registration System

By default, the core scrub function runs the built-in detectors in priority order. You can optionally pass `disabledDetectors` in the `ScrubOptions` to turn off specific built-ins.

### Rule Packs & Custom Detectors

Custom detectors can be passed in during the initialization of the library, effectively overriding or appending to the default list. 

A "Rule Pack" is simply a standard npm package that exports one or more functions or classes conforming to the `Detector` interface. This allows the community to build project-specific rules. 

Users can register rule packs via the CLI or by passing them into the `customDetectors` array in the library API. Installed rule packs can be listed using the `prompt-scrub rules list` command.
