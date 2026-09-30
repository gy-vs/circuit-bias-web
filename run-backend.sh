#!/usr/bin/env bash
# Start the backend (serves API at :8000 and the built editor when frontend/dist exists).
set -euo pipefail
cd "$(dirname "$0")/backend"
export PYTHONPATH="$PWD"
exec python3 -m uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8000}"
