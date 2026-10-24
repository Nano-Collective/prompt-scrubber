---
"@nanocollective/prompt-scrub": patch
---

Fixed the proxy forwarding a secret unscrubbed when it sat under a key that names one in tool-call arguments. A `password`, `api_key`, `token` or `client_secret` in OpenAI `tool_calls[].function.arguments` or `function_call.arguments`, in Anthropic `tool_use.input`, or in a request's `metadata` is now replaced with a placeholder and restored in the reply. The value was scrubbed on its own with no key, so nothing marked it as a secret. Values under other keys are scrubbed exactly as before.
