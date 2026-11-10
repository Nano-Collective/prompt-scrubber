---
"@nanocollective/prompt-scrub": minor
---

Added built-in detectors for credit card numbers (`CreditCard`, Luhn-checked), US Social Security numbers (`Ssn`), IBANs (`Iban`, mod-97-checked) and IPv4 and IPv6 addresses (`IpAddress`). A card or IBAN that passes its checksum is scored at 0.95, a labelled SSN at 0.9 and a bare `123-45-6789` at 0.8, and an IP address at 0.85, so a `--min-confidence` threshold does not drop them ahead of a bare URL. Closes #89.

**Behaviour change:** detector priority is now Secret, CreditCard, Iban, Ssn, Email, Url, Path, IpAddress, Phone. Card, IBAN and SSN rank above Email and Url, so a run of digits that used to become `«Phone_N»` can now become `«CreditCard_N»` or `«Ssn_N»`, and a URL with a card number or SSN in its path is split around it. IpAddress ranks below Url, so an IP inside a URL stays part of the `«Url_N»`.
