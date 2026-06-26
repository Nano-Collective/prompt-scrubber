#!/usr/bin/env bash
set -e

echo "--- test:format ---"
pnpm run test:format

echo "--- test:types ---"
pnpm run test:types

echo "--- test:lint ---"
pnpm run test:lint

echo "--- test:ava ---"
pnpm run test:ava

echo "--- test:knip ---"
pnpm run test:knip

echo "--- test:audit ---"
pnpm run test:audit

if command -v semgrep >/dev/null 2>&1; then
  echo "--- test:security ---"
  pnpm run test:security
else
  echo "--- test:security (skipped: semgrep not found in PATH. Hint: 'pip install semgrep') ---"
fi
