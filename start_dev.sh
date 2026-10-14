#!/usr/bin/env bash
# Start the FastAPI backend (:8000) and the Next.js frontend (:3000) together.
# Ctrl+C stops both.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND="$ROOT/backend"
FRONTEND="$ROOT/frontend"
VENV_PY="$BACKEND/.venv/bin/python"

if [[ ! -x "$VENV_PY" ]]; then
  echo "error: no virtualenv at $VENV_PY" >&2
  echo "       cd backend && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt" >&2
  exit 1
fi

if [[ ! -d "$FRONTEND/node_modules" ]]; then
  echo "error: frontend dependencies missing" >&2
  echo "       cd frontend && npm install" >&2
  exit 1
fi

pids=()

# Kill the whole process group on exit, otherwise `next dev` keeps :3000 bound.
cleanup() {
  trap - INT TERM EXIT
  for pid in "${pids[@]:-}"; do
    [[ -n "$pid" ]] && kill -- "-$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

echo "backend  -> http://localhost:8000  (docs at /docs)"
( cd "$BACKEND" && set -m && exec "$VENV_PY" -m uvicorn main:app --reload --port 8000 ) &
pids+=("$!")

echo "frontend -> http://localhost:3000"
( cd "$FRONTEND" && set -m && exec npm run dev -- --port 3000 ) &
pids+=("$!")

echo ""
echo "Both servers starting. Open http://localhost:3000"
echo "Press Ctrl+C to stop both."
echo ""

# Exit as soon as either server dies, so a crashed backend doesn't look healthy.
# macOS ships bash 3.2, which has no `wait -n`, so poll the pids instead.
while :; do
  for pid in "${pids[@]}"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "a server exited, shutting down the other" >&2
      exit 1
    fi
  done
  sleep 1
done
