"""FastAPI application: stateless circuit analysis service.

POST /api/analyze receives a full electrical circuit and returns the
operating point plus AC response (or structured diagnostics) computed from
that single, consistent input.  Nothing is stored between requests.
"""
from __future__ import annotations

import hashlib
import json
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import engine
from .models import AnalysisResult, Circuit

app = FastAPI(title="circuit-bias-web API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def electrical_fingerprint(circuit: Circuit) -> str:
    """Hash of the *electrical* content only (layout never enters the engine)."""
    payload = circuit.model_dump(exclude_none=True, by_alias=True)
    blob = json.dumps(payload, sort_keys=True, ensure_ascii=False,
                      separators=(",", ":")).encode()
    return hashlib.sha256(blob).hexdigest()[:16]


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.post("/api/analyze", response_model=AnalysisResult)
def analyze_circuit(circuit: Circuit):
    fingerprint = electrical_fingerprint(circuit)
    try:
        result = engine.analyze(circuit)
    except engine.CircuitError as exc:
        return AnalysisResult(status="error", request_hash=fingerprint,
                              diagnostics=exc.diagnostics)
    return AnalysisResult(request_hash=fingerprint, **result)


# Production convenience: serve the built editor when present.
_STATIC_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "frontend", "dist")
if os.path.isdir(_STATIC_DIR):
    app.mount("/assets",
              StaticFiles(directory=os.path.join(_STATIC_DIR, "assets")),
              name="assets")

    @app.get("/")
    def index():
        return FileResponse(os.path.join(_STATIC_DIR, "index.html"))
