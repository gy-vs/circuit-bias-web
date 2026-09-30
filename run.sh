# Convenience launcher: build frontend if needed, then serve app + API on :8000
set -e
cd "$(dirname "$0")"

if [ ! -d frontend/node_modules ]; then
  (cd frontend && npm install)
fi
(cd frontend && npm run build)

export PYTHONPATH=backend
exec python3 -m uvicorn app.main:app --host 127.0.0.1 --port 8000 \
  --app-dir backend
