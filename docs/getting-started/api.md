---
title: "API Reference"
description: "Using prompt-scrub as a Node.js library"
sidebar_order: 1
---

# v1 API Reference

The primary interface for `prompt-scrub` is designed to be simple and stateless from the caller's perspective, delegating session persistence to the library.

## Core Functions

### `scrub`

Scrubs identifying content from a prompt or message.

```typescript
import { scrub } from '@nanocollective/prompt-scrub';

const result = scrub({
  content: prompt, // A string or an array of {role, content} objects
  sessionId: "abc123" // Optional. If omitted, a new session is generated.
});

// result.scrubbedContent contains the text with placeholders
// result.sessionId contains the session ID used
```

### `rehydrate`

Restores the original identifying content into a model response.

```typescript
import { rehydrate } from '@nanocollective/prompt-scrub';

const restored = rehydrate({
  content: response, // The response from the LLM containing placeholders
  sessionId: "abc123" // The session ID used during the scrub phase
});

// restored.content contains the rehydrated text
// restored.warnings contains any placeholders hallucinated by the model
```

## Cache-Aware Determinism
For a given session ID and input text, `scrub()` is **deterministic**. The system generates byte-identical output across repeated calls with the same map. This property is critical because it preserves provider prompt caching (which relies on exact prefix bytes).

You can verify this byte stability via the CLI's `inspect --hash` command, which computes the exact SHA-256 hash of the output that would be generated.

## Types

```typescript
export interface Message {
  role: string;
  content: string;
}

export interface ScrubRequest {
  content: string | Message[];
  sessionId?: string;
  options?: ScrubOptions;
}

export interface ScrubOptions {
  customDetectors?: Detector[];
  disabledDetectors?: string[]; // Array of detector names to skip
}

export interface ScrubResult {
  scrubbedContent: string | Message[];
  sessionId: string;
}

export interface RehydrateRequest {
  content: string;
  sessionId: string;
}

export interface RehydrateResult {
  content: string;
  warnings?: string[]; // Populated if the model invents a placeholder not in the session map
}
```
