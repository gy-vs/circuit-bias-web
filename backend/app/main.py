"""Circuit Bias Web - HTTP API.

Endpoints
----------
POST /api/solve            full DC operating point + AC frequency response
GET  /api/default-circuit  the circuit shown when the workbench first opens
GET  /api/health

The API is intentionally stateless: every request carries a complete circuit
description, so the same operating point and response can be reproduced with
curl or any other client.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

from .analysis import analyze
from .default_circuit import build_default_circuit

app = FastAPI(title="Circuit Bias Web", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/api/default-circuit")
def default_circuit():
    return build_default_circuit()


@app.post("/api/solve")
async def solve(request: Request):
    try:
        body = await request.json()
    except (json.JSONDecodeError, UnicodeDecodeError):
        return JSONResponse(status_code=400, content={
            "ok": False,
            "hash": None,
            "diagnostics": [{
                "code": "BAD_JSON",
                "message": "请求体不是合法的 JSON。",
                "severity": "error",
            }],
            "warnings": [],
            "operating_point": None,
            "frequency_response": None,
        })

    circuit = body.get("circuit", body) if isinstance(body, dict) else body
    sweep = body.get("sweep") if isinstance(body, dict) else None
    input_source = body.get("input_source") if isinstance(body, dict) else None
    return analyze(circuit, sweep_spec=sweep, input_source_id=input_source)


# Optional production hosting of the built frontend (vite build -> frontend/dist)
_DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if _DIST.is_dir():
    from fastapi.staticfiles import StaticFiles

    app.mount("/assets", StaticFiles(directory=_DIST / "assets"), name="assets")

    @app.get("/")
    def index():
        return FileResponse(_DIST / "index.html")
