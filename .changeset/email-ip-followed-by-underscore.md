---
"@nanocollective/prompt-scrub": patch
---

Fixed an email address or an IPv4 address being left in the clear when an underscore followed it, as in `alice@example.com_backup.zip` and `gw 192.168.10.25_old`. An underscore cannot be part of a domain or of an address, so the address is now found and the suffix is kept. A letter after an IPv4 address, a digit after the top-level label of an email, and an underscore before an IPv4 address (where `build_1.2.3.4` is a version) behave as before.
