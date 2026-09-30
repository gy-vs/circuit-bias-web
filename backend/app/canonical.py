"""Electrical fingerprint of a circuit.

The fingerprint contains only what changes the electrical equations:
component types, terminal connections, and numeric parameters; plus probe
terminal references and the ground node. Names and purely graphical data
(positions, orientation) are intentionally excluded so that moving parts on
the canvas never invalidates a result.
"""
from __future__ import annotations

import hashlib
import json
from typing import Any


def electrical_canonical(data: dict) -> dict:
    """Extract electrical content from a raw circuit description.

    Works on plain dicts so the frontend can implement the same procedure.
    Defaults must match models.PARAM_DEFAULTS.
    """
    components = []
    for c in data.get("components", []) or []:
        if not isinstance(c, dict):
            continue
        ctype = c.get("type")
        params = dict(c.get("params") or {})
        if ctype == "voltage_source":
            params.setdefault("ac_mag", 1.0)
            params.setdefault("ac_phase", 0.0)
        components.append({
            "t": ctype,
            "n": list(c.get("nodes") or []),
            "p": {k: params[k] for k in sorted(params)},
        })
    components.sort(key=lambda c: json.dumps(c, sort_keys=True))

    probes = []
    for p in data.get("probes", []) or []:
        if isinstance(p, dict):
            probes.append({"+": p.get("plus"), "-": p.get("minus")})
    probes.sort(key=lambda p: json.dumps(p, sort_keys=True))

    node_ids = []
    for n in data.get("nodes") or []:
        if isinstance(n, dict) and n.get("id"):
            node_ids.append(n["id"])
        elif isinstance(n, str):
            node_ids.append(n)

    return {
        "g": data.get("ground"),
        "nodes": sorted(node_ids),
        "components": components,
        "probes": probes,
    }


def _canonical_text(data: dict) -> str:
    return json.dumps(electrical_canonical(data), sort_keys=True,
                      separators=(",", ":"), ensure_ascii=False)


def circuit_hash(data: dict) -> str:
    return hashlib.sha256(_canonical_text(data).encode("utf-8")).hexdigest()[:16]
