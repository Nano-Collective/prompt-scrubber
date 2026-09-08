---
"@nanocollective/prompt-scrub": patch
---

chore: address baseline CI findings (semgrep + adjacent hardening)

The shared Nano-Collective/.github pr-checks workflow now runs
`semgrep scan --config auto --error` against the whole repo, which
exposes pre-existing baseline issues that the previous workflow
configuration tolerated:

- `src/detectors/code-tell.ts`: drop the `new RegExp(...)` built
  from user input in favour of a single-pass character scan with
  per-term length and term-count caps. Word-boundary semantics and
  the longest-match preference are preserved; all existing detector
  tests still pass. The constructor now exposes a `getDiagnostics()`
  API that reports any terms dropped because they exceeded the caps.

- `pnpm-workspace.yaml`: add the three supply-chain hardening
  settings (`blockExoticSubdeps`, `minimumReleaseAge`,
  `trustPolicy`) at the top level, per the current pnpm schema.

- `.github/dependabot.yml`: add a 7-day cooldown to both ecosystem
  blocks so freshly published packages get a settling period
  before being proposed.
