#!/usr/bin/env bash
# Containerized test/build runner — ALL Node work runs inside a container so the
# host stays clean (no host pnpm/node_modules). Integration tests use testcontainers
# (GreenMail), spawned via the host Docker socket; --network host lets the test
# process reach GreenMail's mapped ports at localhost.
#
# Usage: ./run-tests.sh [all|unit|build]
#   unit  — typecheck + lint + unit tests (fast, no Docker-in-Docker)
#   all   — unit + integration (GreenMail via testcontainers)   [default]
#   build — typecheck + production build (tsc)
set -euo pipefail
cd "$(dirname "$0")"

IMAGE="node:24-bookworm"
MODE="${1:-all}"

case "$MODE" in
  unit)  STEPS="pnpm run typecheck && pnpm run lint && pnpm test" ;;
  all)   STEPS="pnpm run typecheck && pnpm run lint && pnpm test && pnpm run test:integration" ;;
  build) STEPS="pnpm run typecheck && pnpm run build" ;;
  *) echo "usage: run-tests.sh [all|unit|build]" >&2; exit 2 ;;
esac

DOCKER_ARGS=(
  --rm
  --network host
  -v "$PWD":/app -w /app
  -v email-mcp-node-modules:/app/node_modules
  -v email-mcp-pnpm-store:/root/.local/share/pnpm/store
  -e CI=true
  -e TESTCONTAINERS_RYUK_DISABLED=true
)
# Integration tests need the Docker socket to spawn GreenMail.
if [ "$MODE" != "build" ]; then
  DOCKER_ARGS+=(-v /var/run/docker.sock:/var/run/docker.sock)
fi

exec docker run "${DOCKER_ARGS[@]}" "$IMAGE" \
  bash -lc "corepack enable && pnpm install --frozen-lockfile && $STEPS"
