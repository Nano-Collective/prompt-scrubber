---
"@nanocollective/prompt-scrub": patch
---

Fixed an email address or an IPv4 address being left in the clear when an underscore sat next to it, as in `alice@example.com_backup.zip`, `gw 192.168.10.25_old` and `host_192.168.10.25`. An underscore cannot be part of a domain or of an address, so the address is now found and the rest is kept. A 4-part version after a keyword and an underscore (`build_1.2.3.4`, `version_1.2.3.4`) is still left alone, as it is after a space, and a letter after an IPv4 address or a digit after the top-level label of an email behave as before.
