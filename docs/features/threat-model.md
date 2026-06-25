---
title: "Threat Model"
description: "Documentation for Threat Model"
sidebar_order: 1
---

# What `prompt-scrub` Is and Isn't (Threat Model)

`prompt-scrub` operates exclusively at the content layer. It modifies the text you send, not how you send it. This document clarifies exactly what the tool defends against, what it partially mitigates, and what it cannot protect you from.

## In Scope (Defended by v1)

- **Accidental secret leakage in prompts**: Strong defense. The secret detector catches the common API key, token, and credential shapes with high precision. Missing a credential is worse than missing a name, and the detector is tuned accordingly.
- **Accidental identifier leakage in one-off prompts**: Strong defense. Email, phone, postal address, path, and URL detectors catch the obvious shapes with conservative defaults. A user who pastes a prompt with their contact details and a path or two gets clean text out, with the original values on disk under the session map for rehydration.

## Partial Defense (Reduced but not eliminated)

- **Cloud LLM providers reading identifying content in prompts and tool results**: The detectors reduce what is visible. They do not eliminate it: a paragraph that says "my project at `/Users/me/work` has this weird bug" becomes "my project at `Path_1` has this weird bug", which is materially less identifying but not zero.
- **Long-term provider profile building from prompt content**: Stable session mappings prevent identifier-level correlation across a single session (the same email maps to the same `Email_1` on every turn). They do not address stylistic fingerprinting, and a determined provider can still build a profile across sessions.
- **Tool call results in agentic settings**: The scrubber operates on every message regardless of origin, so `ls`, `git log`, `cat`, and `grep` results are scrubbed before the next LLM turn. Coverage is limited to the configured detectors (paths, names, URLs, etc.); the host of leaks a clever tool call could produce is not enumerated exhaustively in v1.

## Out of Scope (Not defended by v1)

- **An adversary on the user's machine**: `prompt-scrub` runs locally; if the local environment is compromised, the prompt is too. The session maps on disk are plaintext JSON in v1, and an attacker with the user's account can read them. (Encryption at rest is a v1.1 follow-up).
- **Semantic leakage**: A question that is inherently identifying (your private codebase, a niche bug only you have, a number only your accountant knows) cannot be made anonymous by stripping identifiers. Stripping identifiers from "what is wrong with my taxes given I made $X this year" does not anonymize the question.
- **Style fingerprinting**: The v1 brute force approach does not rewrite style. The way you phrase things, the words you choose, the cadence of your questions, all go out unchanged. The phase 2 model-based rewriter is the path to address this; in v1, it is a known gap.
- **Harmful content moderation**: Not a `prompt-scrub` job. The tool is trying to catch identifying content, not harmful content.
- **Anything at the network or key layer**: The scrubber does not run on the network and does not see it. A user who needs this protection composes with a network tool of their own choosing (a VPN, Tor, a self-hosted relay, or a proxy).

## Out of scope, and easy to mistake for in-scope

- **Network-level identification of the user's traffic to the LLM provider**: The scrubber does not see the network. IP address, network fingerprint, request timing, headers — all of these are the network layer's problem, and the scrubber cannot help with any of them. A user who needs network-layer privacy composes the scrubber with a network tool. The integration shape is "scrub, send, rehydrate" — a network tool on the request path is additive, not coupled.
