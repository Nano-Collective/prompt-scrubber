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
- `CreditCardDetector`: Detects 16-digit (Visa, Mastercard, Discover) and 15-digit (American Express) card numbers, validated with the Luhn (Mod-10) checksum so barcodes and serial numbers are rejected.
- `IbanDetector`: Detects International Bank Account Numbers, validated against the ISO 13616 country registry (code and exact length) and the ISO 7064 MOD-97 checksum.
- `SsnDetector`: Detects US Social Security Numbers, rejecting values that break SSA structural rules (area of `000`, `666`, or `900-999`; group of `00`; serial of `0000`). The delimited `AAA-GG-SSSS` form (hyphen or space) matches on its own. The continuous form requires a nearby `SSN`, `social security`, or `tax id` label, because an unlabelled 9-digit run is more often an order ID or error code than an SSN.
- `IpAddressDetector`: Detects IPv4 (with strict 0-255 octet bounds and an optional CIDR suffix) and IPv6 addresses in full and compressed notation.

### Opt-in Detectors (Off by Default)

- `NameDetector`: Detects proper nouns (capitalized words). Because proper-noun detection has a high risk of false positives, this detector is **disabled by default**. It can be enabled via the API or CLI. It also features a "strict mode" that leverages an allowlist to skip common countries, languages, and products to minimize false positives.
- `CodeTellDetector`: Detects user-enumerated private identifiers and variables. It is **disabled by default** because the false-positive risk of supplying overly generic terms on code payloads is very high. It acts as a no-op unless explicitly configured with a list of terms.

## Priority & Collision System

When multiple detectors flag overlapping spans, a collision resolution system determines which finding wins.

Priority is implicitly handled by a defined order of precedence:
1. `SecretDetector` (highest priority - missing a secret is dangerous)
2. `CreditCardDetector`
3. `IbanDetector`
4. `SsnDetector`
5. `EmailDetector`
6. `UrlDetector`
7. `PathDetector`
8. `IpAddressDetector`
9. `PhoneDetector`
10. `AddressDetector`
11. `NameDetector`
12. `CodeTellDetector`

If `SecretDetector` and `UrlDetector` match the same string (e.g., a URL with a token), `SecretDetector` wins.

## Registration System

By default, the core scrub function runs the built-in detectors in priority order. You can optionally configure detectors via `ScrubOptions` in the API, or through the CLI:

- **Disable defaults**: Pass `disabledDetectors` (or `--disable` via CLI) to turn off specific built-ins.
- **Enable opt-ins**: Pass `enabledDetectors` (or `--enable` via CLI) to activate off-by-default detectors like `NameDetector`.
- **Strict Mode**: Pass `strictNameDetector: true` (or `--strict-name` via CLI) to reduce false positives for the `NameDetector`.
- **Code Tell**: Pass `codeTellTerms` (or `--code-tell-terms` via CLI) as an array of identifiers to enable and configure the `CodeTellDetector`.

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
  "urlAllowlist": []
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
