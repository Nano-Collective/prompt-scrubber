---
"@nanocollective/prompt-scrub": minor
---

Fixed the **proxy** dropping messages and leaking PII in tool-calling conversations. `messages[]` was filtered by the presence of a `content` key, so an assistant turn that carries only `tool_calls` was deleted from the forwarded body and the upstream saw a tool result answering a call it had never been told about. Messages are now walked, never filtered: anything the proxy does not recognise is forwarded unchanged at its original position.

The same pass now scrubs the fields tool-calling requests actually put text in, all of which were previously forwarded in the clear: Anthropic's top-level `system` prompt (string or text blocks), `tool_calls[].function.arguments`, `tool_use.input`, `tool_result` blocks, the `description` fields of `tools[]` and their JSON schemas, and the deprecated-but-still-accepted `function_call.arguments` / `functions[]`. Argument strings are parsed and scrubbed value by value, so argument keys and JSON structure survive untouched.

Responses are rehydrated in the same places, since the client executes those tool calls on its own machine and needs the real values back. On a stream that includes holding a trailing partial placeholder back until the next fragment of the same call arrives: vendors emit roughly one token per event, so `«Email_1»` normally arrives in pieces, and resolving it only within a single event would have handed the caller's own code a literal placeholder most of the time.

> **Note:** tool names, tool-call ids, schema property keys and `enum` values are deliberately left alone — the model must echo them back verbatim for the caller's dispatch to work. `tool_use.input` in an Anthropic *response* is now rehydrated, where previously it was left holding placeholders.

Closes #163.
