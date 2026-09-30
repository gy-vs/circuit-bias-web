#!/usr/bin/env bash
# Vite dev server with /api proxied to the backend on :8000.
set -euo pipefail
cd "$(dirname "$0")/frontend"
exec npm run dev
