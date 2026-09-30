"""Circuit data model and strict validation with structured diagnostics."""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Optional


# ---------------------------------------------------------------------------
# Diagnostics
# ---------------------------------------------------------------------------

def diagnostic(code: str, message: str, *, severity: str = "error",
               components: Optional[list[str]] = None,
               nodes: Optional[list[str]] = None,
               probes: Optional[list[str]] = None) -> dict:
    d: dict[str, Any] = {"code": code, "message": message, "severity": severity}
    if nodes:
        d["nodes"] = nodes
    if components:
        d["components"] = components
    if probes:
        d["probes"] = probes
    return d


# ---------------------------------------------------------------------------
# Internal model
# ---------------------------------------------------------------------------

ALLOWED_TYPES = ("resistor", "capacitor", "voltage_source", "diode")

# parameter name -> (required, finite, lower bound inclusive, upper bound)
PARAM_SPECS: dict[str, dict[str, tuple[bool, float | None, float | None]]] = {
    "resistor": {"resistance": (True, 0.0, None)},
    "capacitor": {"capacitance": (True, 0.0, None)},
    "voltage_source": {
        "dc": (True, None, None),
        "ac_mag": (False, 0.0, None),
        "ac_phase": (False, None, None),
    },
    "diode": {
        "saturation_current": (True, 0.0, None),
        "thermal_voltage": (True, 0.0, None),
    },
}

PARAM_DEFAULTS = {"voltage_source": {"ac_mag": 1.0, "ac_phase": 0.0}}

# parameters that must be strictly positive (others with a lower bound allow 0)
STRICT_POSITIVE = {"resistance", "capacitance", "saturation_current", "thermal_voltage"}


@dataclass
class Node:
    id: str
    name: str


@dataclass
class Component:
    id: str
    type: str
    nodes: tuple[str, str]   # terminal 0 -> terminal 1 (diode: anode -> cathode)
    name: str
    params: dict[str, float] = field(default_factory=dict)


@dataclass
class Probe:
    id: str
    plus: str
    minus: str
    name: str


@dataclass
class Circuit:
    ground: str
    nodes: list[Node]
    components: list[Component]
    probes: list[Probe]

    def node_map(self) -> dict[str, Node]:
        return {n.id: n for n in self.nodes}

    def component_map(self) -> dict[str, Component]:
        return {c.id: c for c in self.components}

    def voltage_sources(self) -> list[Component]:
        return [c for c in self.components if c.type == "voltage_source"]


def _is_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(float(v))


def _is_id(v: Any) -> bool:
    return isinstance(v, str) and v.strip() != ""


def validate_circuit(data: Any) -> tuple[Optional[Circuit], list[dict]]:
    """Parse and validate a circuit description.

    Returns (circuit, diagnostics). circuit is None only when the top-level
    structure is unusable; otherwise a best-effort circuit is returned and the
    error diagnostics prevent solving.
    """
    diags: list[dict] = []

    if not isinstance(data, dict):
        return None, [diagnostic("STRUCTURE", "电路描述必须是一个 JSON 对象。")]

    raw_nodes = data.get("nodes")
    raw_components = data.get("components")
    raw_probes = data.get("probes", [])
    ground = data.get("ground")

    # ---- nodes ----
    nodes: list[Node] = []
    node_ids: set[str] = set()
    if not isinstance(raw_nodes, list):
        diags.append(diagnostic("STRUCTURE", "缺少 nodes 列表。", nodes=[]))
    else:
        for i, item in enumerate(raw_nodes):
            if not isinstance(item, dict):
                diags.append(diagnostic("STRUCTURE", f"nodes[{i}] 必须是对象。"))
                continue
            nid = item.get("id")
            if not _is_id(nid):
                diags.append(diagnostic("STRUCTURE", f"nodes[{i}] 缺少有效 id。"))
                continue
            if nid in node_ids:
                diags.append(diagnostic("DUPLICATE_ID", f"节点 id 重复: {nid}", nodes=[nid]))
                continue
            name = item.get("name") if _is_id(item.get("name")) else nid
            nodes.append(Node(id=nid, name=name))
            node_ids.add(nid)

    # ---- ground ----
    if not _is_id(ground):
        diags.append(diagnostic("MISSING_GROUND", "电路描述缺少接地点 id（ground 字段）。"))
    elif ground not in node_ids:
        diags.append(diagnostic("UNKNOWN_NODE", f"接地点引用了不存在的节点: {ground}", nodes=[ground]))

    # ---- components ----
    components: list[Component] = []
    comp_ids: set[str] = set()
    if not isinstance(raw_components, list):
        diags.append(diagnostic("STRUCTURE", "缺少 components 列表。"))
    else:
        for i, item in enumerate(raw_components):
            if not isinstance(item, dict):
                diags.append(diagnostic("STRUCTURE", f"components[{i}] 必须是对象。"))
                continue
            cid = item.get("id")
            ctype = item.get("type")
            if not _is_id(cid):
                diags.append(diagnostic("STRUCTURE", f"components[{i}] 缺少有效 id。"))
                continue
            if cid in comp_ids:
                diags.append(diagnostic("DUPLICATE_ID", f"器件 id 重复: {cid}", components=[cid]))
                continue
            if ctype not in ALLOWED_TYPES:
                diags.append(diagnostic(
                    "UNKNOWN_TYPE",
                    f"器件 {cid} 的类型不支持: {ctype!r}，允许 {', '.join(ALLOWED_TYPES)}。",
                    components=[cid]))
                continue

            # terminals
            term_nodes = item.get("nodes")
            refs: list[str] = []
            if not (isinstance(term_nodes, list) and len(term_nodes) == 2):
                diags.append(diagnostic(
                    "BAD_TERMINALS", f"器件 {cid} 需要恰好两个端子 nodes: [t0, t1]。",
                    components=[cid]))
            else:
                for t, ref in enumerate(term_nodes):
                    if not _is_id(ref):
                        diags.append(diagnostic(
                            "BAD_TERMINALS", f"器件 {cid} 的端子 {t} 缺少有效节点 id。",
                            components=[cid]))
                    elif ref not in node_ids:
                        diags.append(diagnostic(
                            "UNKNOWN_NODE", f"器件 {cid} 的端子 {t} 引用了不存在的节点: {ref}",
                            components=[cid], nodes=[ref]))
                    else:
                        refs.append(ref)
            if len(refs) != 2:
                continue  # cannot safely keep this component

            # params
            raw_params = item.get("params", {})
            if not isinstance(raw_params, dict):
                diags.append(diagnostic(
                    "BAD_PARAMS", f"器件 {cid} 的 params 必须是对象。", components=[cid]))
                continue
            params: dict[str, float] = dict(PARAM_DEFAULTS.get(ctype, {}))
            spec = PARAM_SPECS[ctype]
            bad = False
            for key, val in raw_params.items():
                if key not in spec:
                    diags.append(diagnostic(
                        "UNKNOWN_FIELD", f"器件 {cid} 的参数 {key} 不会被使用。",
                        severity="warning", components=[cid]))
                    continue
                if not _is_number(val):
                    diags.append(diagnostic(
                        "BAD_PARAMS", f"器件 {cid} 的参数 {key} 必须是有限数值。",
                        components=[cid]))
                    bad = True
                    continue
                required, lo, hi = spec[key]
                fval = float(val)
                if lo is not None:
                    ok = (fval > lo) if key in STRICT_POSITIVE else (fval >= lo)
                    if not ok:
                        diags.append(diagnostic(
                            "BAD_PARAMS", f"器件 {cid} 的参数 {key} 必须为正数，收到 {fval:g}。",
                            components=[cid]))
                        bad = True
                        continue
                params[key] = fval
            for key, (required, _lo, _hi) in spec.items():
                if required and key not in params:
                    diags.append(diagnostic(
                        "MISSING_PARAM", f"器件 {cid} 缺少参数 {key}。", components=[cid]))
                    bad = True
            if bad:
                continue

            name = item.get("name") if _is_id(item.get("name")) else cid
            components.append(Component(id=cid, type=ctype, nodes=(refs[0], refs[1]),
                                        name=name, params=params))
            comp_ids.add(cid)

    # ---- probes ----
    probes: list[Probe] = []
    probe_ids: set[str] = set()
    if not isinstance(raw_probes, list):
        diags.append(diagnostic("STRUCTURE", "probes 必须是列表。"))
    else:
        for i, item in enumerate(raw_probes):
            if not isinstance(item, dict):
                diags.append(diagnostic("STRUCTURE", f"probes[{i}] 必须是对象。"))
                continue
            pid = item.get("id")
            if not _is_id(pid):
                diags.append(diagnostic("STRUCTURE", f"probes[{i}] 缺少有效 id。"))
                continue
            if pid in probe_ids:
                diags.append(diagnostic("DUPLICATE_ID", f"探针 id 重复: {pid}", probes=[pid]))
                continue
            plus, minus = item.get("plus"), item.get("minus")
            ok = True
            for label, ref in (("plus", plus), ("minus", minus)):
                if not _is_id(ref) or ref not in node_ids:
                    diags.append(diagnostic(
                        "UNKNOWN_NODE",
                        f"探针 {pid} 的 {label} 端引用了不存在的节点: {ref}",
                        probes=[pid], nodes=[ref if _is_id(ref) else "<无效>"]))
                    ok = False
            if not ok:
                continue
            if plus == minus:
                diags.append(diagnostic(
                    "ZERO_PROBE", f"探针 {pid} 的两个端子是同一节点，响应恒为 0。",
                    severity="warning", probes=[pid], nodes=[plus]))
            name = item.get("name") if _is_id(item.get("name")) else pid
            probes.append(Probe(id=pid, plus=plus, minus=minus, name=name))
            probe_ids.add(pid)

    has_errors = any(d["severity"] == "error" for d in diags)
    if has_errors or not nodes or not components:
        if not has_errors and not components:
            diags.append(diagnostic("EMPTY_CIRCUIT", "电路中没有任何器件。"))
        return Circuit(ground=ground or "", nodes=nodes, components=components,
                       probes=probes), diags

    circuit = Circuit(ground=ground, nodes=nodes, components=components, probes=probes)
    return circuit, diags
