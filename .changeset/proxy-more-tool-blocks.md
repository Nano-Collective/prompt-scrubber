---
"@nanocollective/prompt-scrub": patch
---

Fixed the proxy forwarding more tool-calling fields in the clear. The input of an OpenAI custom tool call (`tool_calls[].custom.input`), Anthropic `server_tool_use` and `mcp_tool_use` inputs, `mcp_tool_result` content and the titles of `web_search_tool_result` entries are now scrubbed. Anthropic `/v1/messages/count_tokens`, which takes the whole prompt, is now scrubbed like `/v1/messages` instead of being passed through as an unknown endpoint.
