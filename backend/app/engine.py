"""Circuit solver: DC operating point + small-signal AC analysis.

Everything here operates on purely electrical data.  There are no
coordinates, no demo numbers -- results come from the matrix solves below.

Conventions
-----------
* Every two-terminal device carries current defined as flowing INTO terminal
  n1 (anode / "+" / first terminal), i.e. positive current goes n1 -> n2
  through the device.  A sourcing voltage source therefore reports negative
  current at n1.
* Diode: n1 is the anode, n2 the cathode.  Id = Is*(exp(Vj/Vt) - 1).
* AC gain is reported relative to the chosen input source's AC amplitude.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

from .models import Circuit, Device

TINY = 1e-12          # SPICE-style gmin shunt to ground
ABSTOL = 1e-11
VNTOL = 1e-9
MAX_ITER = 100


class CircuitError(Exception):
    """A collection of structured diagnostics accumulated during analysis."""

    def __init__(self, diagnostics: List[dict]):
        super().__init__("; ".join(d["message"] for d in diagnostics))
        self.diagnostics = diagnostics


def diag(code: str, severity: str, message: str,
         ref_type: Optional[str] = None, ref_id: Optional[str] = None) -> dict:
    return {"code": code, "severity": severity, "message": message,
            "ref_type": ref_type, "ref_id": ref_id}


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

def validate(circuit: Circuit) -> Tuple[Dict[str, dict], Dict[str, Device], Dict[str, dict]]:
    diags: List[dict] = []

    node_ids = [n.id for n in circuit.nodes]
    if len(set(node_ids)) != len(node_ids):
        diags.append(diag("duplicate_node", "error", "节点 id 重复"))
    if circuit.ground not in node_ids:
        diags.append(diag("missing_ground", "error",
                          f"接地节点 '{circuit.ground}' 不在节点列表中",
                          "node", circuit.ground))

    nodes = {n.id: n.model_dump() for n in circuit.nodes}

    dev_ids = [d.id for d in circuit.devices]
    if len(set(dev_ids)) != len(dev_ids):
        diags.append(diag("duplicate_device", "error", "器件 id 重复"))
    devices = {}
    for d in circuit.devices:
        for term, nid in (("n1", d.n1), ("n2", d.n2)):
            if nid not in nodes:
                diags.append(diag("dangling_terminal", "error",
                                  f"器件 {d.id} 的端子 {term} 引用了不存在的节点 '{nid}'",
                                  "device", d.id))
        if d.type == "resistor":
            if d.r is None:
                diags.append(diag("missing_param", "error", f"电阻 {d.id} 缺少参数 r", "device", d.id))
            elif not (math.isfinite(d.r) and d.r > 0):
                diags.append(diag("bad_param", "error",
                                  f"电阻 {d.id} 的阻值必须为正数（当前 {d.r} Ω）", "device", d.id))
        elif d.type == "capacitor":
            if d.c is None:
                diags.append(diag("missing_param", "error", f"电容 {d.id} 缺少参数 c", "device", d.id))
            elif not (math.isfinite(d.c) and d.c > 0):
                diags.append(diag("bad_param", "error",
                                  f"电容 {d.id} 的容值必须为正数（当前 {d.c} F）", "device", d.id))
        elif d.type == "voltage_source":
            if d.dc is None or not math.isfinite(d.dc):
                diags.append(diag("missing_param", "error",
                                  f"电压源 {d.id} 缺少有限的直流电压 dc", "device", d.id))
            if d.n1 == d.n2 and d.dc is not None and math.isfinite(d.dc) and d.dc != 0.0:
                diags.append(diag("shorted_source", "error",
                                  f"电压源 {d.id} 两端接在同一节点却输出 {d.dc} V", "device", d.id))
        elif d.type == "diode":
            if d.model is None:
                diags.append(diag("missing_param", "error",
                                  f"二极管 {d.id} 缺少模型参数 (is, vt)", "device", d.id))
            else:
                if not (d.model.isat > 0 and math.isfinite(d.model.isat)):
                    diags.append(diag("bad_param", "error",
                                      f"二极管 {d.id} 的反向饱和电流必须为正", "device", d.id))
                if not (d.model.vt > 0 and math.isfinite(d.model.vt)):
                    diags.append(diag("bad_param", "error",
                                      f"二极管 {d.id} 的热电压必须为正", "device", d.id))
        devices[d.id] = d

    probes = {}
    probe_ids = [p.id for p in circuit.probes]
    if len(set(probe_ids)) != len(probe_ids):
        diags.append(diag("duplicate_probe", "error", "探针 id 重复"))
    for p in circuit.probes:
        probes[p.id] = p.model_dump()
        for key in ("n_plus", "n_minus"):
            nid = getattr(p, key)
            if nid not in nodes:
                diags.append(diag("dangling_probe", "error",
                                  f"探针 {p.id} 引用了不存在的节点 '{nid}'", "probe", p.id))

    if circuit.input_source is not None:
        src = devices.get(circuit.input_source)
        if src is None:
            diags.append(diag("bad_input_source", "error",
                              f"输入源 '{circuit.input_source}' 不在器件中",
                              "source", circuit.input_source))
        elif src.type != "voltage_source":
            diags.append(diag("bad_input_source", "error",
                              f"输入源 {src.id} 不是电压源", "source", src.id))

    if circuit.sweep.stop < circuit.sweep.start:
        diags.append(diag("bad_sweep", "error", "扫频终止频率必须不小于起始频率"))

    errors = [x for x in diags if x["severity"] == "error"]
    if errors:
        raise CircuitError(diags)
    return nodes, devices, probes


# ---------------------------------------------------------------------------
# Structural checks (purely electrical, independent of values)
# ---------------------------------------------------------------------------

def check_dc_reference(circuit: Circuit, nodes, devices) -> List[dict]:
    diags: List[dict] = []
    dc_adj: Dict[str, set] = {nid: set() for nid in nodes}
    source_edges: List[Tuple[str, str, str]] = []
    for d in circuit.devices:
        if d.type in ("resistor", "diode", "voltage_source"):
            dc_adj[d.n1].add(d.n2)
            dc_adj[d.n2].add(d.n1)
        if d.type == "voltage_source":
            source_edges.append((d.id, d.n1, d.n2))

    seen = {circuit.ground}
    stack = [circuit.ground]
    while stack:
        cur = stack.pop()
        for nb in dc_adj.get(cur, ()):
            if nb not in seen:
                seen.add(nb)
                stack.append(nb)

    for nid, nmeta in nodes.items():
        if nid not in seen:
            attached = [d.id for d in circuit.devices
                        if nid in (d.n1, d.n2)]
            via = ("（仅经电容等直流开路元件" if attached else "（未连接任何器件") + "）"
            diags.append(diag(
                "floating_node", "error",
                f"节点 {nmeta.get('name') or nid} 没有到地的直流通路 {via}，"
                "无法确定直流电位",
                "node", nid))

    # Ideal voltage-source loop: a cycle made only of zero-impedance sources.
    dsu_parent = {nid: nid for nid in nodes}

    def find(x: str) -> str:
        root = x
        while dsu_parent[root] != root:
            root = dsu_parent[root]
        while dsu_parent[x] != root:
            dsu_parent[x], x = root, dsu_parent[x]
        return root

    loop_sources: List[str] = []
    for sid, a, b in source_edges:
        ra, rb = find(a), find(b)
        if ra == rb:
            loop_sources.append(sid)
        else:
            dsu_parent[ra] = rb
    if loop_sources:
        diags.append(diag(
            "voltage_source_loop", "error",
            "存在仅由理想电压源构成的回路（涉及 "
            + ", ".join(loop_sources) + "），直流方程奇异",
            "device", loop_sources[0]))

    return diags


# ---------------------------------------------------------------------------
# Matrix assembly helpers
# ---------------------------------------------------------------------------

@dataclass
class System:
    circuit: Circuit
    active_nodes: List[str]
    nidx: Dict[str, int]
    source_ids: List[str]
    sidx: Dict[str, int]
    dim: int = 0


def make_system(circuit: Circuit) -> System:
    active = [n.id for n in circuit.nodes if n.id != circuit.ground]
    nidx = {nid: i for i, nid in enumerate(active)}
    source_ids = [d.id for d in circuit.devices if d.type == "voltage_source"]
    sidx = {sid: len(active) + i for i, sid in enumerate(source_ids)}
    return System(circuit=circuit, active_nodes=active, nidx=nidx,
                  source_ids=source_ids, sidx=sidx,
                  dim=len(active) + len(source_ids))


def stamp_nodal(A, z, n1: str, n2: str, y, sys: System, ieq=0.0):
    i, j = sys.nidx.get(n1), sys.nidx.get(n2)
    if i is not None:
        A[i, i] += y
        z[i] -= ieq
    if j is not None:
        A[j, j] += y
        z[j] += ieq
    if i is not None and j is not None:
        A[i, j] -= y
        A[j, i] -= y


def stamp_voltage_source(A, z, d: Device, voltage: complex, sys: System):
    k = sys.sidx[d.id]
    i, j = sys.nidx.get(d.n1), sys.nidx.get(d.n2)
    if i is not None:
        A[i, k] += 1.0
        A[k, i] += 1.0
    if j is not None:
        A[j, k] -= 1.0
        A[k, j] -= 1.0
    z[k] += voltage


# ---------------------------------------------------------------------------
# Diode limiting (SPICE-style PN junction limiting)
# ---------------------------------------------------------------------------

def vcrit(isat: float, vt: float) -> float:
    return vt * math.log(vt / (math.sqrt(2.0) * isat))


def limit_junction(vnew: float, vold: float, vt: float, vc: float) -> float:
    if vnew <= vc:
        return vnew
    if vold > 0.0:
        arg = (vnew - vold) / vt
        if abs(arg) < 0.95:
            return vold + vt * math.log1p(arg)
        if arg >= 0.95:
            return vold + vt * (math.log(arg) + 2.0)
        return vc
    return vc


# ---------------------------------------------------------------------------
# DC operating point
# ---------------------------------------------------------------------------

SOURCE_STEPS = [1e-3, 3e-3, 1e-2, 3e-2, 0.1, 0.2, 0.35, 0.5,
                0.65, 0.8, 0.9, 1.0]


def dc_solve(circuit: Circuit, sys: System):
    diode_devs = [d for d in circuit.devices if d.type == "diode"]
    dim = sys.dim
    x = np.zeros(dim)
    vj_lim = {d.id: 0.0 for d in diode_devs}
    critical = {d.id: vcrit(d.model.isat, d.model.vt) for d in diode_devs}

    total_iters = 0
    steps_done = 0

    def attempt(factor: float, x0: np.ndarray, vj0: Dict[str, float],
                max_iter: int) -> Tuple[bool, np.ndarray, Dict[str, float], int]:
        xcur = x0.copy()
        vjprev = dict(vj0)
        for it in range(1, max_iter + 1):
            A = np.zeros((dim, dim))
            z = np.zeros(dim)
            # gmin shunts give every matrix a little backbone
            for nid, i in sys.nidx.items():
                A[i, i] += TINY

            diode_residual = 0.0
            for d in circuit.devices:
                if d.type == "resistor":
                    stamp_nodal(A, z, d.n1, d.n2, 1.0 / d.r, sys)
                elif d.type == "capacitor":
                    pass  # open circuit at DC
                elif d.type == "voltage_source":
                    stamp_voltage_source(A, z, d, factor * d.dc, sys)
                elif d.type == "diode":
                    vi = sys.nidx.get(d.n1)
                    vj_raw = ((xcur[vi] if vi is not None else 0.0)
                              - (xcur[sys.nidx[d.n2]] if d.n2 in sys.nidx else 0.0))
                    vt, isat = d.model.vt, d.model.isat
                    vj = limit_junction(vj_raw, vjprev[d.id], vt, critical[d.id])
                    ev = math.exp(min(vj / vt, 200.0))
                    gd = (isat / vt) * ev
                    ieq = isat * (ev - 1.0) - gd * vj
                    stamp_nodal(A, z, d.n1, d.n2, gd, sys, ieq)
                    vjprev[d.id] = vj
                    # current residual at the *unlimited* new guess
                    id_new = isat * (math.exp(min(vj_raw / vt, 200.0)) - 1.0)
                    diode_residual = max(diode_residual,
                                         abs(id_new - (gd * vj_raw + ieq)))

            try:
                xnew = np.linalg.solve(A, z)
            except np.linalg.LinAlgError:
                return False, xcur, vjprev, it

            dx = xnew - xcur
            xcur = xnew
            node_err = np.max(np.abs(dx[:len(sys.active_nodes)])) if sys.active_nodes else 0.0
            converged = node_err < VNTOL and diode_residual < ABSTOL
            if converged:
                return True, xcur, vjprev, it
        return False, xcur, vjprev, max_iter

    factors = list(SOURCE_STEPS)
    fi = 0
    prev_factor = 0.0
    while fi < len(factors):
        f = factors[fi]
        ok, x, vj_lim, iters = attempt(f, x, vj_lim, MAX_ITER if f == 1.0 else 40)
        total_iters += iters
        if not ok and f < 1.0:
            # insert a gentler midpoint and retry the continuation
            mid = 0.5 * (prev_factor + f)
            if mid > prev_factor + 1e-6:
                factors.insert(fi, mid)
                continue
        if not ok:
            bad = [d.id for d in diode_devs]
            raise CircuitError([diag(
                "dc_no_convergence", "error",
                "直流工作点 Newton 迭代不收敛（二极管 "
                + ", ".join(bad) + "）。可检查偏置极性或串联电阻。",
                "device", bad[0] if bad else None)])
        prev_factor = f
        steps_done += 1
        fi += 1

    return x, total_iters, steps_done


def dc_currents(circuit: Circuit, sys: System, x: np.ndarray) -> Dict[str, float]:
    def v(nid: str) -> float:
        return float(x[sys.nidx[nid]]) if nid in sys.nidx else 0.0

    currents: Dict[str, float] = {}
    for d in circuit.devices:
        v1, v2 = v(d.n1), v(d.n2)
        if d.type == "resistor":
            currents[d.id] = (v1 - v2) / d.r
        elif d.type == "capacitor":
            currents[d.id] = 0.0
        elif d.type == "voltage_source":
            currents[d.id] = float(x[sys.sidx[d.id]])
        elif d.type == "diode":
            vj = v1 - v2
            currents[d.id] = d.model.isat * (math.exp(min(vj / d.model.vt, 200.0)) - 1.0)
    return currents


def diode_quantities(circuit: Circuit, sys: System, x: np.ndarray):
    vj_out, gd_out = {}, {}
    for d in circuit.devices:
        if d.type != "diode":
            continue
        v1 = float(x[sys.nidx[d.n1]]) if d.n1 in sys.nidx else 0.0
        v2 = float(x[sys.nidx[d.n2]]) if d.n2 in sys.nidx else 0.0
        vj = v1 - v2
        vj_out[d.id] = vj
        gd_out[d.id] = (d.model.isat / d.model.vt) * math.exp(min(vj / d.model.vt, 200.0))
    return vj_out, gd_out


# ---------------------------------------------------------------------------
# Small-signal AC analysis at the solved operating point
# ---------------------------------------------------------------------------

def frequency_grid(circuit: Circuit) -> List[float]:
    sw = circuit.sweep
    lo, hi = math.log10(sw.start), math.log10(sw.stop)
    n = int(round((hi - lo) * sw.points_per_decade)) + 1
    grid = list(np.logspace(lo, hi, n))
    grid.extend(f for f in sw.extra if f > 0 and math.isfinite(f))
    grid = sorted(set(round(f, 12) for f in grid))
    return grid


def ac_solve(circuit: Circuit, sys: System, x_dc: np.ndarray, freqs: List[float]):
    gd = {}
    for d in circuit.devices:
        if d.type == "diode":
            v1 = float(x_dc[sys.nidx[d.n1]]) if d.n1 in sys.nidx else 0.0
            v2 = float(x_dc[sys.nidx[d.n2]]) if d.n2 in sys.nidx else 0.0
            vj = v1 - v2
            gd[d.id] = (d.model.isat / d.model.vt) * math.exp(min(vj / d.model.vt, 200.0))

    input_id = circuit.input_source
    input_dev = next(d for d in circuit.devices if d.id == input_id)
    vin_ac = 1.0 if input_dev.ac is None else input_dev.ac

    dim = sys.dim
    probe_data = {p.id: {"n_plus": p.n_plus, "n_minus": p.n_minus,
                         "re": [], "im": []} for p in circuit.probes}

    for f in freqs:
        w = 2.0 * math.pi * f
        s = 1j * w
        A = np.zeros((dim, dim), dtype=complex)
        z = np.zeros(dim, dtype=complex)
        for nid, i in sys.nidx.items():
            A[i, i] += complex(TINY, 0.0)  # tiny real gmin
        for d in circuit.devices:
            if d.type == "resistor":
                stamp_nodal(A, z, d.n1, d.n2, complex(1.0 / d.r, 0.0), sys)
            elif d.type == "capacitor":
                stamp_nodal(A, z, d.n1, d.n2, s * d.c, sys)
            elif d.type == "diode":
                stamp_nodal(A, z, d.n1, d.n2, complex(gd[d.id], 0.0), sys)
            elif d.type == "voltage_source":
                drive = vin_ac if d.id == input_id else 0.0
                stamp_voltage_source(A, z, d, complex(drive, 0.0), sys)
        x = np.linalg.solve(A, z)

        def node_v(nid):
            return complex(x[sys.nidx[nid]]) if nid in sys.nidx else 0.0

        for p in circuit.probes:
            v = node_v(p.n_plus) - node_v(p.n_minus)
            probe_data[p.id]["re"].append(v.real)
            probe_data[p.id]["im"].append(v.imag)

    return probe_data, input_id, vin_ac


# ---------------------------------------------------------------------------
# Top-level entry
# ---------------------------------------------------------------------------

def analyze(circuit: Circuit) -> Dict[str, Any]:
    nodes, devices, probes = validate(circuit)
    ref_diags = check_dc_reference(circuit, nodes, devices)
    if ref_diags:
        raise CircuitError(ref_diags)

    sys = make_system(circuit)

    x_dc, iters, steps = dc_solve(circuit, sys)

    voltages = {nid: (0.0 if nid == circuit.ground else float(x_dc[sys.nidx[nid]]))
                for nid in nodes}
    currents = dc_currents(circuit, sys, x_dc)
    vj_map, gd_map = diode_quantities(circuit, sys, x_dc)

    op = {
        "node_voltages": voltages,
        "device_currents": currents,
        "diode_vj": vj_map,
        "diode_gd": gd_map,
    }

    ac_block = None
    if circuit.input_source is not None and circuit.probes:
        freqs = frequency_grid(circuit)
        probe_raw, input_id, vin_ac = ac_solve(circuit, sys, x_dc, freqs)
        out_probes = {}
        for pid, data in probe_raw.items():
            re = np.array(data["re"])
            im = np.array(data["im"])
            mag = np.sqrt(re * re + im * im)
            gain = np.where(mag > 0, 20.0 * np.log10(mag / abs(vin_ac)), -np.inf)
            phase = np.degrees(np.arctan2(im, re))
            out_probes[pid] = {
                "n_plus": data["n_plus"],
                "n_minus": data["n_minus"],
                "v_real": re.tolist(),
                "v_imag": im.tolist(),
                "magnitude_db": [float(g) for g in gain],
                "phase_deg": [float(p) for p in phase],
            }
        ac_block = {
            "input_source": input_id,
            "input_ac": vin_ac,
            "frequencies": [float(f) for f in freqs],
            "probes": out_probes,
        }

    return {
        "status": "ok",
        "operating_point": op,
        "ac": ac_block,
        "diagnostics": [],
        "meta": {"newton_iterations": int(iters),
                 "source_steps": int(steps),
                 "converged": True},
    }
