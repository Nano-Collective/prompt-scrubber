---
title: "API Reference"
description: "Using prompt-scrub as a Node.js library"
sidebar_order: 1
---

# v1 API Reference

The primary interface for `prompt-scrub` supports both disk-backed sessions and caller-owned stateless sessions.

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

#### Choosing a storage mode

Omit `sessionMap` to use disk-backed storage. When `sessionId` is provided, that session is loaded from and saved to the filesystem; otherwise a new ID is generated.

```typescript
const result = scrub({
  content: prompt,
  sessionId: "abc123"
});
```

Provide a map — including an empty object — to use stateless mode. The same object is updated and returned, and no session file is read or written.

```typescript
const sessionMap = {};
const result = scrub({
  content: prompt,
  sessionId: "abc123", // Optional metadata in stateless mode
  sessionMap
});

console.log(result.sessionMap === sessionMap); // true
```

`sessionMap: undefined` is not stateless mode: at runtime it is treated like an omitted property, selects disk-backed storage, and emits a warning. TypeScript projects with `exactOptionalPropertyTypes` enabled reject that explicit assignment; other TypeScript and JavaScript callers receive the runtime warning. Omit the property for disk mode or pass `{}` for stateless mode.

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
  sessionMap?: SessionMap;
  options?: ScrubOptions;
}

export interface SessionMap {
  [placeholder: string]: string;
}

export interface ScrubOptions {
  customDetectors?: Detector[];
  disabledDetectors?: string[]; // Array of detector names to skip
}

export interface ScrubResult {
  scrubbedContent: string | Message[];
  sessionId?: string;
  sessionMap?: SessionMap;
}

export interface RehydrateRequest {
  content: string | Message[];
  sessionId?: string;
  sessionMap?: SessionMap;
}

export interface RehydrateResult {
  content: string | Message[];
  warnings?: string[]; // Populated if the model invents a placeholder not in the session map
}
```
