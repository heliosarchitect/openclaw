#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

echo "[helios] QA start: $(pwd)"
node -v

if command -v pnpm >/dev/null 2>&1; then
  if [ ! -d node_modules ]; then
    echo "[helios] pnpm install (node_modules missing)"
    pnpm -s install
  fi

  # QA contract: do not auto-format; prefer lint + tests.
  echo "[helios] pnpm lint"
  pnpm -s lint

  if pnpm -s run | grep -q "test:fast"; then
    echo "[helios] pnpm test:fast"
    pnpm -s test:fast
  else
    echo "[helios] pnpm test"
    pnpm -s test
  fi
else
  echo "[helios] ERROR: pnpm not found"
  exit 2
fi

echo "[helios] QA PASS"
