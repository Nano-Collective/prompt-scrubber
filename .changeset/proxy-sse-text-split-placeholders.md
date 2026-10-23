---
"@nanocollective/prompt-scrub": patch
---

Fixed the **proxy** leaking a placeholder in streamed text. A placeholder split across two SSE events (`«Email_` then `1»`) was only restored in tool-call arguments, so `delta.content` and Anthropic `text_delta` reached the client as a literal `«Email_1»`. A trailing partial placeholder in streamed text is now held back and joined to the next fragment, the same way tool-call arguments already were. Closes #167.
