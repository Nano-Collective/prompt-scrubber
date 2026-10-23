---
"@nanocollective/prompt-scrub": patch
---

Fixed an IPv6 address being left in the clear when a colon came straight after it, as in `connect to 2001:db8::1: connection refused`. A run of colon-separated groups that is too long to be an address is still left alone.
