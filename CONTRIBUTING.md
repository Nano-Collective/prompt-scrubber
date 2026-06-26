# Contributing to prompt-scrub

Welcome! We are glad you're here. `prompt-scrub` is an open-source project by the Nano Collective. We welcome contributors of all skill levels. Whether you are fixing a bug, adding a new detector, or improving documentation, your help is appreciated.

## Code of Conduct

All contributors and participants are expected to adhere to the [Nano Collective Code of Conduct](https://nanocollective.org/collective/organisation/community). Please review it before participating.

We also operate under the [Nano Collective Economics Charter](https://nanocollective.org/collective/organisation/economics-charter).

## Development Setup

1. **Clone the repository:**
   ```bash
   git clone https://github.com/Nano-Collective/prompt-scrubber.git
   cd prompt-scrubber
   ```

2. **Install dependencies:**
   We use pnpm for development. If you don't have it, you can bootstrap it via Corepack:
   ```bash
   corepack enable && corepack prepare pnpm@11.0.9 --activate
   pnpm install
   ```

2. **Build the project:**
   ```bash
   pnpm run build
   ```

## Testing and Linting

We maintain a high bar for quality and test coverage. Before submitting a PR, ensure your changes pass the full test and linting gate.

You can run the entire check in one command:
```bash
pnpm run test:all
```

This single command will run through the following gates:
- `pnpm run test:format` - Format checking with Biome
- `pnpm run test:types` - Type checking with tsc
- `pnpm run test:lint` - Lint checking with Biome
- `pnpm run test:ava` - Ava test suite
- `pnpm run test:knip` - Dead code analysis
- `pnpm run test:audit` - Security audit of dependencies
- `pnpm run test:security` - Static analysis with Semgrep (if installed)

You can also run any of these individual gates in isolation by calling the script name.

### Coding Standards

- **Strictness:** We use strict TypeScript. Avoid `any` where possible.
- **Error Handling:** Use clear, descriptive error messages. Throw native `Error` objects or specific subclasses.
- **Formatting:** Handled automatically by Biome. Do not disable lint rules without a comment explaining why.

## Release Process

**Note for contributors:** Please do not bump the version number in `package.json` in your pull requests. Version bumping and releases are handled exclusively by the project maintainers using automated workflows when merging to `main`.

Thank you for contributing!
