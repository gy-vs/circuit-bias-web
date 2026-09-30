"""DC operating point and small-signal AC solver.

Method: modified nodal analysis on dense complex matrices with NumPy.

* Resistors, capacitors and diodes contribute current to KCL; independent
  voltage sources get MNA branch-current unknowns.
* DC diodes are solved with Newton-Raphson (exp clipped, damping and source
  stepping fallback).
* AC uses the linearized diode conductance at the operating point; the chosen
  input source is the only active source and probe voltage is divided by its
  phasor, so gain is meaningful for any amplitude/phase.

Current convention: positive component current flows from terminal 0 to
terminal 1 (for diodes: anode -> cathode). For a voltage source, positive
current flows *out of* its positive terminal, i.e. delivered by the source.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from .models import Circuit, Component, diagnostic


MAX_ITER = 100
EXP_CLIP = 75.0          # exp argument cap, comfortably within float64
VTOL = 1e-9              # KCL residual convergence (A)
STOL = 1e-9              # voltage source residual convergence (V)
JUNCTION_GMIN = 1e-9     # tiny parallel conductance, stabilises cut-off diodes


@dataclass
class DCResult:
    voltages: dict[str, float]
    currents: dict[str, float]
    diode_extras: dict[str, dict]
    diagnostics: list[dict]


@dataclass
class ACResult:
    freqs: list[float]
    probes: dict[str, dict]   # probe id -> {gain_db, phase_deg}
    diagnostics: list[dict]


# ---------------------------------------------------------------------------
# Topology checks (DC connectivity)
# ---------------------------------------------------------------------------

def topology_diagnostics(circuit: Circuit) -> list[dict]:
    diags: list[dict] = []
    node_ids = {n.id for n in circuit.nodes}
    ground = circuit.ground

    # DC-conducting edges: resistors, diodes, voltage sources (zero resistance)
    # Capacitors are open at DC.
    dc_adj: dict[str, set[str]] = {nid: set() for nid in node_ids}
    # All edges, including capacitors, for the connectivity contrast below.
    all_adj: dict[str, set[str]] = {nid: set() for nid in node_ids}
    for c in circuit.components:
        a, b = c.nodes
        all_adj[a].add(b)
        all_adj[b].add(a)
        if c.type in ("resistor", "diode", "voltage_source"):
            dc_adj[a].add(b)
            dc_adj[b].add(a)

    def reachable(adj: dict[str, set[str]]) -> set[str]:
        seen = {ground}
        stack = [ground]
        while stack:
            cur = stack.pop()
            for nxt in adj[cur]:
                if nxt not in seen:
                    seen.add(nxt)
                    stack.append(nxt)
        return seen

    floating = sorted(node_ids - reachable(dc_adj))
    if floating:
        attached = sorted(node_ids - reachable(all_adj))
        cap_only = sorted(set(floating) - set(attached))
        if cap_only:
            diags.append(diagnostic(
                "FLOATING_NODE",
                "下列节点只经电容或经完全悬空支路与电路相连，直流下没有确定电位: "
                + ", ".join(cap_only),
                nodes=cap_only))
        truly_loose = [x for x in floating if x in attached]
        if truly_loose:
            diags.append(diagnostic(
                "FLOATING_NODE",
                "下列节点在直流下没有到地的电导通路（完全悬空），无法确定直流电位: "
                + ", ".join(truly_loose),
                nodes=truly_loose))

    # Pure voltage-source loops make the DC matrix singular.
    vs_components = [c for c in circuit.components if c.type == "voltage_source"]
    cycle = _voltage_source_cycle(circuit, vs_components)
    if cycle is not None:
        diags.append(diagnostic(
            "DC_SINGULAR",
            "存在仅由理想电压源构成的回路，回路电流无唯一解: "
            + " -> ".join(cycle) + "。请串联一个小电阻。",
            components=cycle[:-1]))

    return diags


def _voltage_source_cycle(circuit: Circuit, sources: list[Component]) -> list[str] | None:
    """Find a cycle in the graph whose edges are ideal voltage sources."""
    adj: dict[str, list[tuple[str, str]]] = {}
    for c in sources:
        a, b = c.nodes
        adj.setdefault(a, []).append((b, c.id))
        adj.setdefault(b, []).append((a, c.id))

    # parent node / arriving component id per DFS forest
    parent: dict[str, tuple[str | None, str | None]] = {}

    def ancestors(x: str) -> list[str]:
        path = []
        while x is not None:
            path.append(x)
            x = parent[x][0]
        return path

    for root in list(adj):
        if root in parent:
            continue
        parent[root] = (None, None)
        stack: list[tuple[str, list[tuple[str, str]]]] = [(root, list(adj.get(root, [])))]
        while stack:
            node, edges = stack[-1]
            if not edges:
                stack.pop()
                continue
            nxt, cid = edges.pop()
            pnode, pvia = parent[node]
            if nxt == pnode and cid == pvia:
                continue
            if nxt in parent:
                # back edge node-nxt closes a cycle; walk parents to LCA
                sa = set(ancestors(node))
                lca = next(x for x in ancestors(nxt) if x in sa)
                side_a, cur = [], node
                while cur != lca:
                    side_a.append(cur)
                    cur = parent[cur][0]
                side_b, cur = [], nxt
                while cur != lca:
                    side_b.append(cur)
                    cur = parent[cur][0]
                return side_a + [lca] + list(reversed(side_b)) + [nxt]
            parent[nxt] = (node, cid)
            stack.append((nxt, list(adj.get(nxt, []))))
    return None


# ---------------------------------------------------------------------------
# DC operating point
# ---------------------------------------------------------------------------

def solve_dc(circuit: Circuit) -> DCResult:
    diags = topology_diagnostics(circuit)
    if diags:
        return DCResult({}, {}, {}, diags)

    node_ids = [n.id for n in circuit.nodes]
    idx = {nid: i for i, nid in enumerate(node_ids)}
    gidx = idx[circuit.ground]
    active = [i for i in range(len(node_ids)) if i != gidx]
    sources = circuit.voltage_sources()
    sidx = {c.id: k for k, c in enumerate(sources)}

    n = len(active)
    m = len(sources)
    size = n + m
    active_pos = {old: new for new, old in enumerate(active)}
    # row/col of a node inside the reduced system, or -1 for ground
    row_of = {old: active_pos.get(old, -1) for old in range(len(node_ids))}

    def stamp_diode(c: Component, v: np.ndarray, J: np.ndarray, F: np.ndarray):
        a, b = (idx[c.nodes[0]], idx[c.nodes[1]])
        Is, Vt = c.params["saturation_current"], c.params["thermal_voltage"]
        vd = v[a] - v[b]
        e = np.exp(min(vd / Vt, EXP_CLIP))
        # current (anode -> cathode) and its derivative w.r.t. vd
        iD = Is * (e - 1.0)
        gd = Is * e / Vt + JUNCTION_GMIN
        ra, rb = row_of[a], row_of[b]
        if ra >= 0:
            F[ra] += iD + JUNCTION_GMIN * vd
            J[ra, ra] += gd
        if rb >= 0:
            F[rb] -= iD + JUNCTION_GMIN * vd
            J[rb, rb] += gd
        if ra >= 0 and rb >= 0:
            J[ra, rb] -= gd
            J[rb, ra] -= gd
        return iD, gd

    def residual(vals: np.ndarray, source_scale: float):
        v = np.zeros(len(node_ids))
        v[active] = vals[:n]
        J = np.zeros((size, size))
        F = np.zeros(size)

        # conductance matrix: resistors (capacitors open at DC)
        G = np.zeros((len(node_ids), len(node_ids)))
        for c in circuit.components:
            if c.type == "resistor":
                a, b = idx[c.nodes[0]], idx[c.nodes[1]]
                g = 1.0 / c.params["resistance"]
                G[a, a] += g
                G[b, b] += g
                G[a, b] -= g
                G[b, a] -= g
        F[:n] += G[active][:, active] @ v[active]
        J[:n, :n] += G[active][:, active]

        diode_state: dict[str, tuple[float, float]] = {}
        for c in circuit.components:
            if c.type == "diode":
                iD, gd = stamp_diode(c, v, J, F)
                diode_state[c.id] = (iD, gd)

        # voltage sources: branch unknown i = current delivered by source
        # (leaving terminal 0). KCL rows: -i at t0, +i at t1;
        # source equation row: v(t0)-v(t1) = Vdc.
        for k, c in enumerate(sources):
            a, b = idx[c.nodes[0]], idx[c.nodes[1]]
            ra, rb = row_of[a], row_of[b]
            row = n + k
            ibranch = vals[row]
            if ra >= 0:
                F[ra] -= ibranch
                J[ra, row] -= 1.0
                J[row, ra] += 1.0
            if rb >= 0:
                F[rb] += ibranch
                J[rb, row] += 1.0
                J[row, rb] -= 1.0
            F[row] += (v[a] - v[b]) - source_scale * c.params["dc"]

        return F, J, diode_state

    diode_objs = [c for c in circuit.components if c.type == "diode"]

    def diode_limit_alpha(vals: np.ndarray, delta: np.ndarray) -> float:
        """SPICE-style per-diode junction voltage limiting -> step scale."""
        v = np.zeros(len(node_ids))
        v[active] = vals[:n]
        v2 = np.zeros(len(node_ids))
        v2[active] = (vals + delta)[:n]
        alpha = 1.0
        for c in diode_objs:
            Vt = c.params["thermal_voltage"]
            old = v[idx[c.nodes[0]]] - v[idx[c.nodes[1]]]
            new = v2[idx[c.nodes[0]]] - v2[idx[c.nodes[1]]]
            limit = Vt * 2.0 + max(0.0, old)
            if new - old > limit:
                alpha = min(alpha, limit / (new - old))
            if new > 0.0 and old < 0.0:
                # do not cross straight from reverse bias into conduction
                alpha = min(alpha, min(0.5, (-old) / (new - old)))
        return alpha

    def newton_stage(vals: np.ndarray, source_scale: float) -> bool:
        for _it in range(MAX_ITER):
            F, J, _ = residual(vals, source_scale)
            if (np.max(np.abs(F[:n])) < VTOL
                    and (m == 0 or np.max(np.abs(F[n:])) < STOL)):
                return True
            try:
                delta = np.linalg.solve(J, -F)
            except np.linalg.LinAlgError:
                return False

            alpha = diode_limit_alpha(vals, delta)

            # backtrack: accept only a step that keeps residuals finite
            for _bt in range(40):
                trial = vals + alpha * delta
                Ftry, _, _ = residual(trial, source_scale)
                if np.all(np.isfinite(Ftry)):
                    break
                alpha *= 0.5
            else:
                return False
            vals[:] = trial
            if alpha < 1e-12:
                return False
        return False

    vals = np.zeros(size)
    converged = False
    try:
        if newton_stage(vals, 1.0):
            converged = True
        else:
            # source stepping fallback: restart from 0 V with a smooth ramp
            vals = np.zeros(size)
            steps = 20
            converged = True
            for k in range(1, steps + 1):
                if not newton_stage(vals, k / steps):
                    converged = False
                    break
    except (OverflowError, FloatingPointError):
        converged = False

    if not converged:
        return DCResult({}, {}, {}, [diagnostic(
            "DC_NO_CONVERGE",
            "直流牛顿迭代未能收敛（可能是偏置过大或二极管参数极端）。",
        )])

    F, _, diode_state = residual(vals, 1.0)
    vfull = np.zeros(len(node_ids))
    vfull[active] = vals[:n]
    branch = vals[n:]

    voltages = {nid: float(vfull[idx[nid]]) for nid in node_ids}
    currents: dict[str, float] = {}
    diode_extras: dict[str, dict] = {}
    for c in circuit.components:
        a, b = idx[c.nodes[0]], idx[c.nodes[1]]
        va, vb = vfull[a], vfull[b]
        if c.type == "resistor":
            currents[c.id] = float((va - vb) / c.params["resistance"])
        elif c.type == "capacitor":
            currents[c.id] = 0.0
        elif c.type == "diode":
            iD, gd = diode_state[c.id]
            currents[c.id] = float(iD)
            diode_extras[c.id] = {
                "conductance": float(gd),
                "dynamic_resistance": float(1.0 / gd) if gd > 0 else math.inf,
                "voltage": float(va - vb),
            }
        else:
            # source branch current: current leaving terminal 0
            currents[c.id] = float(branch[sidx[c.id]])

    return DCResult(voltages, currents, diode_extras, [])


# ---------------------------------------------------------------------------
# Small-signal AC
# ---------------------------------------------------------------------------

def solve_ac(circuit: Circuit, dc: DCResult, freqs: list[float],
             input_source_id: str) -> ACResult:
    diags: list[dict] = []
    sources = circuit.voltage_sources()
    if not sources:
        return ACResult([], {}, [diagnostic(
            "NO_INPUT_SOURCE", "电路中没有独立电压源，无法计算频率响应。")])
    if input_source_id not in {c.id for c in sources}:
        input_source_id = sources[0].id
        diags.append(diagnostic(
            "INPUT_FALLBACK",
            f"指定的输入源无效，改用 {input_source_id}。", severity="warning"))
    input_src = next(c for c in sources if c.id == input_source_id)
    if input_src.params["ac_mag"] <= 0.0:
        return ACResult([], {}, [diagnostic(
            "ZERO_INPUT", f"输入源 {input_src.id} 的 AC 幅度为 0，无法定义增益。",
            components=[input_src.id])])

    node_ids = [n.id for n in circuit.nodes]
    idx = {nid: i for i, nid in enumerate(node_ids)}
    gidx = idx[circuit.ground]
    active = [i for i in range(len(node_ids)) if i != gidx]
    n = len(active)
    m = len(sources)
    size = n + m
    active_pos = {old: new for new, old in enumerate(active)}
    row_of = {old: active_pos.get(old, -1) for old in range(len(node_ids))}
    sidx = {c.id: k for k, c in enumerate(sources)}

    base = np.zeros((size, size), dtype=np.complex128)
    for c in circuit.components:
        a, b = idx[c.nodes[0]], idx[c.nodes[1]]
        ra, rb = row_of[a], row_of[b]
        if c.type == "resistor":
            g = 1.0 / c.params["resistance"]
            if ra >= 0:
                base[ra, ra] += g
            if rb >= 0:
                base[rb, rb] += g
            if ra >= 0 and rb >= 0:
                base[ra, rb] -= g
                base[rb, ra] -= g
        elif c.type == "diode":
            gd = dc.diode_extras[c.id]["conductance"]
            if ra >= 0:
                base[ra, ra] += gd
            if rb >= 0:
                base[rb, rb] += gd
            if ra >= 0 and rb >= 0:
                base[ra, rb] -= gd
                base[rb, ra] -= gd
        else:  # voltage source topology (capacitor admittance added per-frequency)
            if c.type == "voltage_source":
                k = sidx[c.id]
                row = n + k
                if ra >= 0:
                    base[ra, row] -= 1.0
                    base[row, ra] += 1.0
                if rb >= 0:
                    base[rb, row] += 1.0
                    base[row, rb] -= 1.0

    mag = input_src.params["ac_mag"]
    phase_rad = math.radians(input_src.params["ac_phase"])
    vs_phasor = mag * np.exp(1j * phase_rad)

    probe_data: dict[str, dict[str, list[float]]] = {
        p.id: {"gain_db": [], "phase_deg": []} for p in circuit.probes}
    complex_gain: dict[str, list[complex]] = {p.id: [] for p in circuit.probes}

    for f in freqs:
        Y = base.copy()
        omega = 2.0 * math.pi * f
        for c in circuit.components:
            if c.type != "capacitor":
                continue
            a, b = idx[c.nodes[0]], idx[c.nodes[1]]
            ra, rb = row_of[a], row_of[b]
            yc = 1j * omega * c.params["capacitance"]
            if ra >= 0:
                Y[ra, ra] += yc
            if rb >= 0:
                Y[rb, rb] += yc
            if ra >= 0 and rb >= 0:
                Y[ra, rb] -= yc
                Y[rb, ra] -= yc

        rhs = np.zeros(size, dtype=np.complex128)
        k = sidx[input_src.id]
        rhs[n + k] = vs_phasor

        try:
            sol = np.linalg.solve(Y, rhs)
        except np.linalg.LinAlgError:
            return ACResult([], {}, [diagnostic(
                "AC_SINGULAR",
                f"频率 {f:g} Hz 处小信号矩阵奇异，电路缺少参考或约束不足。",
                nodes=[nid for nid in node_ids if nid != circuit.ground][:1])])

        v = np.zeros(len(node_ids), dtype=np.complex128)
        v[active] = sol[:n]
        for p in circuit.probes:
            vp = v[idx[p.plus]] - v[idx[p.minus]]
            complex_gain[p.id].append(vp / vs_phasor)

    for pid, gains in complex_gain.items():
        g = np.asarray(gains)
        mag_db = 20.0 * np.log10(np.maximum(np.abs(g), 1e-300))
        # unwrap phase to remove +/-180deg jumps, in degrees
        phase = np.degrees(np.unwrap(np.angle(g)))
        probe_data[pid] = {
            "gain_db": [float(x) for x in mag_db],
            "phase_deg": [float(x) for x in phase],
        }

    return ACResult([float(f) for f in freqs], probe_data, diags)
