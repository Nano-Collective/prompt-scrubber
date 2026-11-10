---
"@nanocollective/prompt-scrub": patch
---

Fixed the **proxy** leaking a placeholder in streamed text. A placeholder split across two SSE events (`«Email_` then `1»`) was only restored in tool-call arguments, so `delta.content` and Anthropic `text_delta` reached the client as a literal `«Email_1»`. A trailing partial placeholder in streamed text is now held back and joined to the next fragment, the same way tool-call arguments already were. A held fragment that is never completed (ordinary text ending in `«`) is released before the event that ends its text or call (`finish_reason`, `content_block_stop`, `message_stop` or `[DONE]`), so a client that stops reading there does not lose it. Closes #167.
