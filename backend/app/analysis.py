"""End-to-end analysis pipeline: one circuit in, one consistent result out."""
from __future__ import annotations

import math
from typing import Any

import numpy as np

from .canonical import circuit_hash
from .models import Circuit, diagnostic, validate_circuit
from .solver import solve_ac, solve_dc

DEFAULT_SWEEP = {"type": "log", "start": 1.0, "stop": 100_000.0, "num": 100}
MAX_POINTS = 5000


def build_sweep(spec: Any) -> tuple[list[float] | None, list[dict]]:
    diags: list[dict] = []
    if spec is None:
        spec = DEFAULT_SWEEP
    if not isinstance(spec, dict):
        return None, [diagnostic("BAD_SWEEP", "sweep 必须是对象。")]

    stype = spec.get("type", "log")
    if stype == "list":
        raw = spec.get("points")
        if not isinstance(raw, list) or not raw:
            return None, [diagnostic("BAD_SWEEP", "sweep.points 必须是非空列表。")]
        freqs = []
        for x in raw:
            if not isinstance(x, (int, float)) or isinstance(x, bool) or not math.isfinite(float(x)) or x <= 0:
                diags.append(diagnostic("BAD_SWEEP", f"频率点必须是正有限数: {x!r}"))
            else:
                freqs.append(float(x))
        if diags:
            return None, diags
        return freqs, []

    try:
        start = float(spec.get("start", DEFAULT_SWEEP["start"]))
        stop = float(spec.get("stop", DEFAULT_SWEEP["stop"]))
        num = int(spec.get("num", DEFAULT_SWEEP["num"]))
    except (TypeError, ValueError):
        return None, [diagnostic("BAD_SWEEP", "sweep 的 start/stop/num 必须是数值。")]

    if not (math.isfinite(start) and math.isfinite(stop)) or start <= 0 or stop <= 0:
        return None, [diagnostic("BAD_SWEEP", "sweep 的起止频率必须为正有限数。")]
    if start > stop:
        return None, [diagnostic("BAD_SWEEP", f"起始频率 {start:g} 大于终止频率 {stop:g}。")]
    if not (2 <= num <= MAX_POINTS):
        return None, [diagnostic("BAD_SWEEP", f"频率点数必须在 2..{MAX_POINTS} 之间。")]

    if stype == "log":
        return list(np.geomspace(start, stop, num)), []
    if stype == "linear":
        return list(np.linspace(start, stop, num)), []
    return None, [diagnostic("BAD_SWEEP", f"未知扫频类型: {stype!r}")]


def analyze(data: dict, sweep_spec: Any = None,
            input_source_id: str | None = None) -> dict:
    """Run the full pipeline against a single circuit description.

    The returned dictionary always carries the hash, diagnostics and an
    explicit status so a caller can never mistake a failure for data.
    """
    result: dict[str, Any] = {
        "ok": False,              # DC operating point solved successfully
        "ac_ok": False,           # frequency response solved successfully
        "hash": circuit_hash(data) if isinstance(data, dict) else None,
        "diagnostics": [],
        "warnings": [],
        "operating_point": None,
        "frequency_response": None,
    }

    circuit, diags = validate_circuit(data)
    errors = [d for d in diags if d["severity"] == "error"]
    result["warnings"] = [d for d in diags if d["severity"] == "warning"]
    if errors:
        result["diagnostics"] = errors
        return result

    freqs, sweep_diags = build_sweep(sweep_spec)
    if sweep_diags:
        result["diagnostics"] = sweep_diags
        return result

    assert circuit is not None
    dc = solve_dc(circuit)
    if dc.diagnostics:
        result["diagnostics"] = dc.diagnostics
        return result

    if input_source_id is None and circuit.voltage_sources():
        input_source_id = circuit.voltage_sources()[0].id

    ac = solve_ac(circuit, dc, freqs, input_source_id or "")
    ac_errors = [d for d in ac.diagnostics if d["severity"] == "error"]
    result["warnings"] += [d for d in ac.diagnostics if d["severity"] == "warning"]
    if ac_errors:
        # DC operating point is still valid; surface AC diagnostics but do
        # not fabricate a curve.
        result["diagnostics"] = ac_errors
        result["operating_point"] = {
            "node_voltages": dc.voltages,
            "component_currents": dc.currents,
            "components": dict(dc.diode_extras),
        }
        result["ok"] = True
        result["ac_ok"] = False
        return result
    component_extras = {
        cid: extras for cid, extras in dc.diode_extras.items()
    }
    result["operating_point"] = {
        "node_voltages": dc.voltages,
        "component_currents": dc.currents,
        "components": component_extras,
    }

    probe_meta = {p.id: {"plus": p.plus, "minus": p.minus, "name": p.name}
                  for p in circuit.probes}
    probes_out: dict[str, dict] = {}
    for pid, series in ac.probes.items():
        probes_out[pid] = {**probe_meta[pid], **series}

    result["frequency_response"] = {
        "input_source": input_source_id,
        "freqs": ac.freqs,
        "probes": probes_out,
    }
    result["ok"] = True
    result["ac_ok"] = True
    return result
