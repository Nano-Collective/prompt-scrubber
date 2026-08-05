---
title: "n8n Integration"
description: "Scrub workflow data before it reaches an external LLM"
sidebar_order: 2
---

# n8n Integration

`n8n-nodes-prompt-scrub` is a community node that adds a local privacy step to
n8n workflows. It runs the same detectors and session-aware core API as the
Node.js package; no request is sent to a remote service.

## Install

In a self-hosted n8n instance, install `n8n-nodes-prompt-scrub` as a community
node and restart n8n. Cloud availability depends on the instance's community
node policy.

## Operations

- **Inspect** keeps the selected field unchanged and adds detector categories,
  counts, and spans to the metadata field.
- **Scrub** replaces sensitive values in one string field and creates a session
  reference.
- **Scrub selected fields** replaces values only in the listed dot-separated
  paths, such as `prompt`, `customer.email`, or `messages.0.content`.
- **Rehydrate** restores placeholders in a response field and records any
  placeholders invented by the model as warnings.

All operations process every incoming item and preserve n8n item linking.

## Recommended workflow

1. Add **Prompt Scrub** with **Scrub** and set **Input Field** to the prompt
   field, for example `prompt`.
2. Keep **Session Storage** set to **Local session** and **Return Metadata** on.
   The node adds a session ID under `_promptScrub` and keeps the original values
   on the n8n worker.
3. Configure the LLM node to send only the scrubbed prompt value, not the full
   JSON item. Preserve `_promptScrub.sessionId` for the next step.
4. Add another **Prompt Scrub** node with **Rehydrate**, set **Input Field** to
   the LLM response, and leave **Session ID** empty. It reads the session ID
   from `_promptScrub`.

Example item after Scrub:

```json
{
  "prompt": "Please email «Email_1» about «Secret_1».",
  "_promptScrub": {
    "version": 1,
    "operation": "scrub",
    "storage": "local",
    "sessionId": "...",
    "detected": {
      "count": 2,
      "categories": {
        "Email": 1,
        "Secret": 1
      }
    }
  }
}
```

## Inline session maps

Select **Inline session map** when workers cannot share the local session
directory. The node then places the placeholder-to-original map under the
metadata field so a later Rehydrate operation can run without local disk
state.

The map contains the original sensitive values. Do not pass the metadata field
to an LLM, log it, or store it in an external system unless that is an explicit
security decision. Inline mode trades operational portability for a larger
workflow-data exposure surface.

## Limits

The node protects content, not network identity or writing style. Detectors can
miss sensitive information, so use Inspect when a workflow needs a review step
and treat scrubbed output as a partial defence rather than anonymity.
