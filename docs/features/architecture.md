---
title: "Architecture"
description: "Documentation for Architecture"
sidebar_order: 1
---

# Architecture: prompt-scrub

## High-Level Structure

```text
prompt-scrub
├── src/
│   ├── detectors/
│   │   ├── email.ts
│   │   ├── phone.ts
│   │   ├── path.ts
│   │   ├── secret.ts
│   │   └── url.ts
│   │
│   ├── session/
│   │   ├── session-manager.ts
│   │   └── storage.ts
│   │
│   ├── core/
│   │   ├── scrub.ts
│   │   ├── rehydrate.ts
│   │   └── collision-resolver.ts
│   │
│   ├── cli/
│   │   └── commands/
│   │
│   └── types/
```

## Core Components

- **Detectors (`src/detectors/`)**: Pluggable modules responsible for finding identifying information (emails, paths, secrets, etc.) in text and returning standard `Finding` objects.
- **Session Management (`src/session/`)**: Handles creating, loading, and saving session maps to disk (JSON format). Ensures that identifiers remain consistently mapped across a session.
- **Core Pipeline (`src/core/`)**:
  - `scrub.ts`: Orchestrates the detection process, resolves collisions, applies replacements, and updates the session map.
  - `rehydrate.ts`: The reverse process; swaps placeholders back to their original values using the session map.
  - `collision-resolver.ts`: Logic to handle overlapping findings from different detectors (the more specific detector wins).
- **CLI (`src/cli/`)**: Command-line interface wrapping the core library. Exposes commands like `scrub`, `rehydrate`, `inspect`, and session management.
- **Types (`src/types/`)**: Shared TypeScript interfaces (e.g., `Message`, `Finding`, `SessionMap`).

## Data Flow: The `scrub()` Pipeline

A single `scrub()` call flows through a five-step pipeline:

1. **Accept the message**: `scrub()` accepts a string or an array of OpenAI-shaped `{ role, content }` objects.
2. **Stabilise the session map**: If a session ID is provided, the existing map is loaded from disk (or in-process cache). If not, a new UUID and map are created.
3. **Run the detector pipeline**: All enabled detectors run in sequence, producing deterministic `Finding` items for the input text based on the active session map.
4. **Resolve collisions**: If two detectors flag the same or overlapping text, the `collision-resolver` determines the winner based on the defined priority sequence.
5. **Apply the transformations**: The winning findings are replaced with stable placeholders (e.g., `Email_1`), the updated session map is saved, and the scrubbed message is returned alongside the session ID.
