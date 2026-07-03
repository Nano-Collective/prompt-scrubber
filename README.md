# prompt-scrub

Built by the [Nano Collective](https://nanocollective.org) — a community collective building AI tooling not for profit, but for the community.

`prompt-scrub` is a local-first utility designed to strip identifying content out of prompts and messages before they hit any cloud LLM.

![Build Status](https://github.com/Nano-Collective/prompt-scrubber/raw/main/badges/build.svg)
![Coverage](https://github.com/Nano-Collective/prompt-scrubber/raw/main/badges/coverage.svg)
![Version](https://github.com/Nano-Collective/prompt-scrubber/raw/main/badges/npm-version.svg)
![Downloads](https://github.com/Nano-Collective/prompt-scrubber/raw/main/badges/npm-downloads-monthly.svg)
![License](https://github.com/Nano-Collective/prompt-scrubber/raw/main/badges/npm-license.svg)
![Repo Size](https://github.com/Nano-Collective/prompt-scrubber/raw/main/badges/repo-size.svg)
![Stars](https://github.com/Nano-Collective/prompt-scrubber/raw/main/badges/stars.svg)
![Forks](https://github.com/Nano-Collective/prompt-scrubber/raw/main/badges/forks.svg)

It maps sensitive data (emails, secrets, paths, URLs, phone numbers) to stable placeholders locally, allowing you to rehydrate the model's responses back to their original forms securely.

## What it is / What it is not

`prompt-scrub` reduces identity leakage at the **content layer**. It is **partial defence, not anonymity**.

**What it does:**
- Detects and replaces common identifying content (emails, paths, phone numbers, secrets, URLs) before your prompt leaves your machine.
- Maps each value to a stable placeholder so the model's response can be rehydrated locally.
- Gives you an `inspect` command so you can see exactly what was detected and what was missed before you commit to sending.

**What it does not do:**
- It does not make you anonymous. A semantically identifying question (a niche bug only you have, your private codebase, your financial situation) remains identifying after scrubbing.
- It does not address stylistic fingerprinting — the way you phrase things goes out unchanged.
- It does not operate at the network or key layer. Your IP address, request timing, and headers are outside its scope.
- Detectors can and do miss things. Always review the output before sending.

> [!IMPORTANT]
> A user who believes this tool makes them anonymous is worse off than one who never used it — they stop reading their prompts and trust the defaults. Always use `inspect` first to see what the tool actually found.

Read the full [Threat Model](docs/features/threat-model.md) for a complete breakdown of what is and is not defended.

## Quick Start

Install globally to use the CLI:

```bash
npm install -g @nanocollective/prompt-scrub
```

Or install as a dependency in your Node.js project:

```bash
npm install @nanocollective/prompt-scrub
```

### Recommended: Inspect first

Before scrubbing, run `inspect` on a real prompt to review what the tool detected before sending your prompt:

```bash
echo "My email is alice@acme.com and I work at /Users/alice/projects. My phone is +44-7700-900999." \
  | prompt-scrub inspect
```

```
Detected entities:
  [Email]    alice@acme.com                   → Email_1    (chars 12-26)
  [Path]     /Users/alice/projects.           → Path_1     (chars 41-63)
  [Phone]    +44-7700-900999                  → Phone_1    (chars 76-91)

No session written.
Hash: 41beda4af0b83488fdf6eea9347775450a1c7c887a6ef377212340f36c445132
```

The hash is deterministic — the same prompt always produces the same hash, so you can verify cache stability across runs. Once you are satisfied with what `inspect` shows, proceed with `scrub`.

## Usage Examples

**CLI: Scrubbing text**
```bash
echo "My email is user@example.com" | prompt-scrub scrub
# Output: My email is Email_1
```

**Node.js API: Scrubbing and Rehydrating**
```typescript
import { scrub, rehydrate } from '@nanocollective/prompt-scrub';

const prompt = "My key is sk-12345";
const { scrubbedContent, sessionId } = scrub({ content: prompt });
console.log(scrubbedContent); // "My key is Secret_1"

// ... send to LLM ... get response "I see your key is Secret_1"

const { content } = rehydrate({ 
  content: "I see your key is Secret_1", 
  sessionId 
});
console.log(content); // "I see your key is sk-12345"
```

## Documentation

Full user guides and architecture details are in the [`docs/`](docs/) directory:
- [Getting Started](docs/getting-started/index.md)
- [Threat Model](docs/features/threat-model.md)
- [Architecture](docs/features/index.md)

Read the full whitepaper at [docs.nanocollective.org](https://docs.nanocollective.org).

## Community

- **Discord:** [Join the Nano Collective Discord](https://discord.gg/ktPDV6rekE)
- **Contributing:** Read our [Contributing Guide](CONTRIBUTING.md) to get started.
- **Issues:** Check the [GitHub Issues](https://github.com/Nano-Collective/prompt-scrubber/issues) for planned work or to report bugs.
