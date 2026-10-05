---
"@nanocollective/prompt-scrub": minor
---

feat: add built-in detectors for Credit Cards, SSN, IBAN, and IP Addresses (closes #89)

> **Note:** Collision priority for shared shapes has shifted. CreditCard / IBAN / SSN / IPAddress detectors are inserted above Email / Url / Path / Phone / Address, so e.g. an IP embedded in a URL is now part of the Url finding (Url wins by span length) rather than a separate IpAddress entity.
