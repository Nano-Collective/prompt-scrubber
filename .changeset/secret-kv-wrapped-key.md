---
"@nanocollective/prompt-scrub": patch
---

Fixed a `KEY=value` secret being left in the clear when markup or brackets closed the key before the separator, as in `**password**: ...`, `` `password`: ... ``, `config['password'] = '...'`, `os.environ["API_KEY"] = "..."` and `[password]=...`. A secret in JSON that is itself a string (`{\"password\": \"...\"}`) is now found too. A key still needs a secret-looking name and a value of its own.
