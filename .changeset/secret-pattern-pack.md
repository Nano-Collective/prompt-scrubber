---
"@nanocollective/prompt-scrub": minor
---

Added built-in detection for more developer credentials: Stripe live secret and restricted keys (`sk_live_`, `rk_live_`), JSON Web Tokens, PEM private key blocks (PKCS#8, RSA, EC and OpenSSH, including a key stored in JSON with escaped newlines), GitLab personal access tokens (`glpat-`), HuggingFace tokens (`hf_`), npm access tokens (`npm_`), SendGrid API keys (`SG.`) and Slack incoming-webhook URLs. Each is redacted whole as a `Secret` at the same 0.99 confidence as the other vendor keys. Closes #179.
