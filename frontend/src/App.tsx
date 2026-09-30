import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Circuit,
  ComponentDesc,
  ComponentType,
  Diagnostic,
  Position,
  SolveResult,
  SweepSpec,
} from "./types";
import { fetchDefaultCircuit, solveCircuit } from "./api";
import { electricalSnapshot } from "./canonical";
import {
  addNode,
  autoLayout,
  newComponent,
  newProbe,
  normalizeImport,
  removeComponent,
  removeNode,
} from "./circuit";
import { CircuitCanvas, type Selection } from "./components/CircuitCanvas";
import { Inspector } from "./components/Inspector";
import { BodeChart, type FrequencyPick } from "./components/BodeChart";
import "./styles.css";

type SolveStatus = "loading" | "solving" | "done" | "dc-only" | "error";

interface StoredResult {
  hash: string;
  result: SolveResult;
  // electrical revision of the circuit this result was computed from
  rev: number;
  // sweep + input source this result was computed with
  sig: string;
}

function analysisSig(sweep: SweepSpec, inputSource: string | null): string {
  return JSON.stringify({ s: sweep, i: inputSource });
}

const SWEEP_KEY = "cbw.sweep";

export default function App() {
  const [circuit, setCircuit] = useState<Circuit | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  // Bumped only on electrical edits. Graphical-only edits (positions,
  // orientation, display names) never bump it and never invalidate results.
  const [elecRev, setElecRev] = useState(0);
  const [status, setStatus] = useState<SolveStatus>("loading");
  const [result, setResult] = useState<StoredResult | null>(null);
  const [previous, setPrevious] = useState<StoredResult | null>(null);
  const [inputSource, setInputSource] = useState<string | null>(null);
  const [sweep, setSweep] = useState<SweepSpec>(() => {
    const saved = localStorage.getItem(SWEEP_KEY);
    return saved
      ? (JSON.parse(saved) as SweepSpec)
      : { type: "log", start: 1, stop: 100000, num: 120 };
  });
  const [activeProbes, setActiveProbes] = useState<string[]>([]);
  const sig = analysisSig(sweep, inputSource);
  const [pick, setPick] = useState<FrequencyPick | null>(null);
  const [pendingProbePlus, setPendingProbePlus] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const tokenSeq = useRef(0);
  const lastSnap = useRef<string | null>(null);

  // ---- initial load: straight into a working circuit, no intro page ----
  useEffect(() => {
    let alive = true;
    fetchDefaultCircuit()
      .then((c) => {
        if (!alive) return;
        autoLayout(c);
        setCircuit(c);
        lastSnap.current = electricalSnapshot(c);
        setActiveProbes(c.probes.map((p) => p.id));
      })
      .catch(() => setStatus("error"));
    return () => {
      alive = false;
    };
  }, []);

  // ---- debounced solve, keyed by electrical revision + analysis settings ----
  useEffect(() => {
    if (!circuit) return;
    if (result?.rev === elecRev && result?.sig === sig) return;

    const token = ++tokenSeq.current;
    setStatus("solving");
    const timer = setTimeout(() => {
      solveCircuit(circuit, sweep, inputSource).then((res) => {
        if (token !== tokenSeq.current) return; // newer edit superseded this run
        const hash = res.hash ?? "";
        setResult((cur) => {
          if (cur?.result.ac_ok && (cur.rev !== elecRev || cur.sig !== sig)) {
            setPrevious(cur);
          }
          return { hash, result: res, rev: elecRev, sig };
        });
        if (res.ac_ok) setStatus("done");
        else if (res.ok) setStatus("dc-only");
        else setStatus("error");
      });
    }, 220);
    return () => clearTimeout(timer);
    // circuit belongs to the render that produced elecRev; graphical edits
    // change circuit but not elecRev and therefore never trigger a recompute.
    // sig covers sweep range and input source.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elecRev, sig]);

  // clone-edit-commit. electrical=false marks a purely graphical edit that
  // must not invalidate results. Returns the clone for synchronous id reads.
  const mutate = useCallback(
    (fn: (draft: Circuit) => void, electrical = true): Circuit => {
      const draft = structuredClone(circuit as Circuit);
      fn(draft);
      setCircuit(draft);
      if (electrical) {
        const snap = electricalSnapshot(draft);
        if (snap !== lastSnap.current) {
          lastSnap.current = snap;
          setElecRev((r) => r + 1);
        }
      }
      return draft;
    },
    [circuit],
  );

  // ------------------------------------------------------- graphical edits
  const moveComponent = (id: string, pos: Position) =>
    mutate((d) => {
      const c = d.components.find((x) => x.id === id);
      if (c) c.position = pos;
    }, false);

  const moveNode = (id: string, pos: Position) =>
    mutate((d) => {
      const n = d.nodes.find((x) => x.id === id);
      if (n) n.position = pos;
    }, false);

  // ------------------------------------------------------- electrical edits
  const connectTerminal = (cid: string, terminal: 0 | 1, nodeId: string) =>
    mutate((d) => {
      const c = d.components.find((x) => x.id === cid);
      if (c) c.nodes[terminal] = nodeId;
    });

  const updateComponent = (id: string, patch: Partial<ComponentDesc>) =>
    mutate((d) => {
      const c = d.components.find((x) => x.id === id);
      if (c) Object.assign(c, patch);
      // name-only patches do not change the electrical snapshot, so the
      // revision is not bumped; terminals/params patches do bump it.
    });

  const updateParam = (id: string, key: string, value: number) =>
    mutate((d) => {
      const c = d.components.find((x) => x.id === id);
      if (c) c.params[key] = value;
    });

  const renameNode = (id: string, name: string) =>
    mutate((d) => {
      const n = d.nodes.find((x) => x.id === id);
      if (n) n.name = name;
    }, false);

  const setGround = (id: string) =>
    mutate((d) => {
      d.ground = id;
    });

  const deleteNode = (id: string) => {
    mutate((d) => removeNode(d, id));
    setSelection((s) => (s?.kind === "node" && s.id === id ? null : s));
  };

  const deleteComponent = (id: string) => {
    mutate((d) => removeComponent(d, id));
    setSelection((s) => (s?.kind === "component" && s.id === id ? null : s));
    setInputSource((src) => (src === id ? null : src));
  };

  const renameProbe = (id: string, name: string) =>
    mutate((d) => {
      const p = d.probes.find((x) => x.id === id);
      if (p) p.name = name;
    }, false);

  const deleteProbe = (id: string) => {
    mutate((d) => {
      d.probes = d.probes.filter((p) => p.id !== id);
    });
    setActiveProbes((a) => a.filter((x) => x !== id));
    setPick((p) => (p?.probeId === id ? null : p));
    setSelection((s) => (s?.kind === "probe" && s.id === id ? null : s));
  };

  const setProbeTerminal = (id: string, side: "plus" | "minus", nodeId: string) =>
    mutate((d) => {
      const p = d.probes.find((x) => x.id === id);
      if (p) p[side] = nodeId;
    });

  // probe building: first double-click picks +, second picks −
  const probeClickNode = (nodeId: string) => {
    if (pendingProbePlus === null) {
      setPendingProbePlus(nodeId);
      setSelection({ kind: "node", id: nodeId });
    } else if (pendingProbePlus === nodeId) {
      setPendingProbePlus(null);
    } else {
      const plus = pendingProbePlus;
      let newId = "";
      mutate((d) => {
        const probe = newProbe(plus, nodeId, new Set(d.probes.map((p) => p.id)));
        probe.name = `${d.nodes.find((n) => n.id === plus)?.name ?? plus} − ${
          d.nodes.find((n) => n.id === nodeId)?.name ?? nodeId
        }`;
        d.probes.push(probe);
        newId = probe.id;
      });
      setActiveProbes((a) => [...a, newId]);
      setSelection({ kind: "probe", id: newId });
      setPendingProbePlus(null);
    }
  };

  const addComponentOfType = (type: ComponentType) => {
    let newId = "";
    mutate((d) => {
      const c = newComponent(type, new Set(d.components.map((x) => x.id)));
      c.position = { x: 200 + Math.random() * 500, y: 180 + Math.random() * 260 };
      d.components.push(c);
      newId = c.id;
    });
    setSelection({ kind: "component", id: newId });
  };

  const addNodeTool = () => {
    let newId = "";
    mutate((d) => {
      newId = addNode(d);
      const n = d.nodes.find((x) => x.id === newId)!;
      n.position = { x: 200 + Math.random() * 600, y: 160 + Math.random() * 300 };
    });
    setSelection({ kind: "node", id: newId });
  };

  // ------------------------------------------------------------- import/export
  const doExport = () => {
    if (!circuit) return;
    const blob = new Blob([JSON.stringify(circuit, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "circuit.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  const doImport = (file: File) => {
    file
      .text()
      .then((text) => normalizeImport(JSON.parse(text)))
      .then((parsed) => {
        autoLayout(parsed);
        setCircuit(parsed);
        lastSnap.current = electricalSnapshot(parsed);
        setElecRev((r) => r + 1);
        setResult(null);
        setPrevious(null);
        setPick(null);
        setSelection(null);
        setPendingProbePlus(null);
        setInputSource(null);
        setActiveProbes(parsed.probes.map((p) => p.id));
      })
      .catch((err) => alert(`导入失败：${err.message ?? err}`));
  };

  const voltageSources = useMemo(
    () => circuit?.components.filter((c) => c.type === "voltage_source") ?? [],
    [circuit],
  );

  if (!circuit) return <div className="boot">正在载入电路工作台…</div>;

  const resultCurrent =
    result?.rev === elecRev && result?.sig === sig ? result : null;
  const resultStale =
    result && (result.rev !== elecRev || result.sig !== sig) ? result : null;
  const comparison: StoredResult | null =
    resultStale ??
    (previous && (previous.rev !== elecRev || previous.sig !== sig) ? previous : null);

  const shownResult = resultCurrent?.result ?? null;
  const op = shownResult?.operating_point ?? null;
  const response = shownResult?.frequency_response ?? null;
  const diagnostics = status === "solving" ? [] : shownResult?.diagnostics ?? [];
  const warnings = status === "solving" ? [] : shownResult?.warnings ?? [];
  const computing = status === "solving" || status === "loading";

  return (
    <div className="app">
      <header className="topbar">
        <h1>Circuit Bias Web</h1>
        <div className="toolbar">
          <button className="btn" onClick={() => addComponentOfType("voltage_source")}>＋电压源</button>
          <button className="btn" onClick={() => addComponentOfType("resistor")}>＋电阻</button>
          <button className="btn" onClick={() => addComponentOfType("capacitor")}>＋电容</button>
          <button className="btn" onClick={() => addComponentOfType("diode")}>＋二极管</button>
          <button className="btn ghost" onClick={addNodeTool}>＋节点</button>
          <span className="sep" />
          <button className="btn" onClick={() => fileInput.current?.click()}>导入</button>
          <button className="btn" onClick={doExport}>导出</button>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) doImport(f);
              e.target.value = "";
            }}
          />
        </div>
        <StatusPill
          status={status}
          hash={resultCurrent?.hash ?? null}
          computing={computing || (!resultCurrent && resultStale !== null)}
        />
      </header>

      <main className="layout">
        <section className="left-pane">
          <div className="canvas-wrap">
            <CircuitCanvas
              circuit={circuit}
              selection={selection}
              diagnostics={[...diagnostics, ...warnings]}
              op={op}
              probeIds={activeProbes}
              onSelect={setSelection}
              onMoveComponent={moveComponent}
              onMoveNode={moveNode}
              onConnectTerminal={connectTerminal}
              onProbeClickNode={probeClickNode}
            />
            {pendingProbePlus && (
              <div className="probe-hint">
                正在放置探针：+ 端 = {circuit.nodes.find((n) => n.id === pendingProbePlus)?.name}，
                双击另一个节点作为 − 端（再次双击 + 端取消）。
              </div>
            )}
          </div>
          <Inspector
            circuit={circuit}
            selection={selection}
            onUpdateComponent={updateComponent}
            onUpdateParam={updateParam}
            onSetTerminal={connectTerminal}
            onRenameNode={renameNode}
            onSetGround={setGround}
            onDeleteNode={deleteNode}
            onDeleteComponent={deleteComponent}
            onRenameProbe={renameProbe}
            onDeleteProbe={deleteProbe}
            onStartProbe={(id) => setPendingProbePlus(id)}
            pendingProbePlus={pendingProbePlus}
            onCancelProbe={() => setPendingProbePlus(null)}
            onSetProbeTerminal={setProbeTerminal}
          />
        </section>

        <section className="right-pane">
          <SweepControls
            sweep={sweep}
            onChange={(s) => {
              setSweep(s);
              localStorage.setItem(SWEEP_KEY, JSON.stringify(s));
            }}
            sources={voltageSources}
            inputSource={inputSource ?? voltageSources[0]?.id ?? null}
            onSelectSource={setInputSource}
          />

          <DiagnosticsPanel
            diagnostics={diagnostics}
            warnings={warnings}
            status={status}
            onSelect={setSelection}
          />

          {op && resultCurrent && <OperatingPointPanel op={op} circuit={circuit} />}

          {status === "error" && !comparison && (
            <div className="card no-curve">
              当前电路无法计算，没有曲线数据；修复诊断中关联的器件或节点后会自动重算。
            </div>
          )}

          {response && resultCurrent && (
            <div className="card result">
              <h3>
                频率响应
                <span className="tag ok-tag">当前结果 · hash {resultCurrent.hash.slice(0, 8)}</span>
              </h3>
              <div className="probe-toggles">
                {Object.entries(response.probes).map(([pid, p]) => {
                  const on = activeProbes.includes(pid);
                  return (
                    <label key={pid} className="probe-toggle">
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() =>
                          setActiveProbes(on
                            ? activeProbes.filter((x) => x !== pid)
                            : [...activeProbes, pid])
                        }
                      />
                      {p.name} <small>(+{p.plus} / −{p.minus})</small>
                    </label>
                  );
                })}
              </div>
              <BodeChart
                response={response}
                op={op!}
                resultHash={resultCurrent.hash}
                activeProbeIds={activeProbes}
                onPickFrequency={setPick}
                highlightedFreq={pick?.hash === resultCurrent.hash ? pick.freq : null}
              />
              {pick?.hash === resultCurrent.hash && (
                <PickCard
                  pick={pick}
                  circuit={circuit}
                  op={op}
                  onSelectProbe={() => setSelection({ kind: "probe", id: pick.probeId })}
                />
              )}
            </div>
          )}

          {comparison && (
            <PreviousResult stored={comparison} circuit={circuit} />
          )}
        </section>
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------

function StatusPill({ status, hash, computing }: {
  status: SolveStatus;
  hash: string | null;
  computing: boolean;
}) {
  const cls = computing
    ? "busy"
    : { loading: "muted", solving: "busy", done: "ok", "dc-only": "warn", error: "bad" }[status];
  const text = computing
    ? "电路已改动，正在计算新结果…"
    : {
        loading: "载入中",
        solving: "计算中…",
        done: "计算完成（结果对应当前电路）",
        "dc-only": "工作点完成 · 频响不可用",
        error: "计算失败（见诊断）",
      }[status];
  return (
    <div className={`status-pill ${cls}`} title={`本次结果电气哈希: ${hash ?? "尚无结果"}`}>
      <span className="dot" />
      {text}
      <code>{hash?.slice(0, 8) ?? "--------"}</code>
    </div>
  );
}

function SweepControls({ sweep, onChange, sources, inputSource, onSelectSource }: {
  sweep: SweepSpec;
  onChange: (s: SweepSpec) => void;
  sources: ComponentDesc[];
  inputSource: string | null;
  onSelectSource: (id: string | null) => void;
}) {
  return (
    <div className="card controls">
      <h3>分析设置</h3>
      <div className="field-row">
        <label>输入源</label>
        <select value={inputSource ?? ""} onChange={(e) => onSelectSource(e.target.value || null)}>
          {sources.length === 0 && <option value="">（无电压源）</option>}
          {sources.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name || c.id} ({c.params.dc} V)
            </option>
          ))}
        </select>
      </div>
      <div className="field-row sweep-row">
        <label>扫频</label>
        <select
          value={sweep.type}
          onChange={(e) => onChange({ ...sweep, type: e.target.value as SweepSpec["type"] })}
        >
          <option value="log">对数</option>
          <option value="linear">线性</option>
        </select>
        <input
          type="number"
          value={sweep.start ?? 1}
          onChange={(e) => onChange({ ...sweep, start: Number(e.target.value) })}
          title="起始 Hz"
        />
        <span>–</span>
        <input
          type="number"
          value={sweep.stop ?? 1e5}
          onChange={(e) => onChange({ ...sweep, stop: Number(e.target.value) })}
          title="终止 Hz"
        />
        <span>Hz，</span>
        <input
          type="number"
          value={sweep.num ?? 120}
          min={2}
          max={5000}
          onChange={(e) => onChange({ ...sweep, num: Number(e.target.value) })}
          title="点数"
        />
        <span>点</span>
      </div>
    </div>
  );
}

function DiagnosticsPanel({ diagnostics, warnings, status, onSelect }: {
  diagnostics: Diagnostic[];
  warnings: Diagnostic[];
  status: SolveStatus;
  onSelect: (s: Selection) => void;
}) {
  if (diagnostics.length === 0 && warnings.length === 0) return null;
  return (
    <div className={`card diag ${status === "error" ? "has-error" : ""}`}>
      <h3>{status === "error" ? "无法计算的原因（关联到电路对象）" : "诊断"}</h3>
      {diagnostics.map((d, i) => (
        <div key={i} className="diag-item error">
          <span className="diag-code">{d.code}</span>
          <span>{d.message}</span>
          <div className="diag-links">
            {d.components?.map((id) => (
              <button key={id} className="link-btn" onClick={() => onSelect({ kind: "component", id })}>
                → 器件 {id}
              </button>
            ))}
            {d.nodes?.map((id) => (
              <button key={id} className="link-btn" onClick={() => onSelect({ kind: "node", id })}>
                → 节点 {id}
              </button>
            ))}
          </div>
        </div>
      ))}
      {warnings.map((d, i) => (
        <div key={`w${i}`} className="diag-item warning">
          <span className="diag-code">{d.code}</span>
          <span>{d.message}</span>
        </div>
      ))}
    </div>
  );
}

function OperatingPointPanel({ op, circuit }: {
  op: NonNullable<SolveResult["operating_point"]>;
  circuit: Circuit;
}) {
  return (
    <div className="card op">
      <h3>直流工作点</h3>
      <div className="op-grid">
        <table>
          <thead>
            <tr><th>节点</th><th>电位 (V)</th></tr>
          </thead>
          <tbody>
            {circuit.nodes.map((n) => (
              <tr key={n.id} className={n.id === circuit.ground ? "ground-row" : ""}>
                <td>{n.name || n.id}{n.id === circuit.ground && " ⏚"}</td>
                <td>{op.node_voltages[n.id]?.toFixed(6)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <table>
          <thead>
            <tr><th>器件</th><th>电流 (A，端子0→1)</th></tr>
          </thead>
          <tbody>
            {circuit.components.map((c) => (
              <tr key={c.id}>
                <td title={c.id}>{c.name || c.id}</td>
                <td>
                  {op.component_currents[c.id] !== undefined
                    ? op.component_currents[c.id].toExponential(4)
                    : "—"}
                  {c.type === "diode" && op.components[c.id] && (
                    <div className="diode-extra">
                      Vd={op.components[c.id].voltage.toFixed(4)} V ·
                      rd={op.components[c.id].dynamic_resistance.toFixed(2)} Ω ·
                      gd={op.components[c.id].conductance.toExponential(3)} S
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PickCard({ pick, circuit, op, onSelectProbe }: {
  pick: FrequencyPick;
  circuit: Circuit;
  op: SolveResult["operating_point"];
  onSelectProbe: () => void;
}) {
  const nameOf = (id: string) => circuit.nodes.find((n) => n.id === id)?.name ?? id;
  return (
    <div className="pick-card">
      <h4>曲线上选取的频率点（点击可回到电路中的探针）</h4>
      <div className="pick-grid">
        <div><b>f</b> = {pick.freq.toPrecision(4)} Hz</div>
        <div><b>幅度</b> = {pick.gainDb.toFixed(3)} dB</div>
        <div><b>相位</b> = {pick.phaseDeg.toFixed(2)}°</div>
      </div>
      <div className="pick-probe">
        来自探针{" "}
        <button className="link-btn" onClick={onSelectProbe}>{pick.probeId}</button>
        ，实际测量 V(<b>{nameOf(pick.plus)}</b>) − V(<b>{nameOf(pick.minus)}</b>)
      </div>
      {op && (
        <div className="pick-op">
          对应这次计算的工作点（hash {pick.hash.slice(0, 8)}）：
          V({nameOf(pick.plus)}) = {op.node_voltages[pick.plus]?.toFixed(4)} V，
          V({nameOf(pick.minus)}) = {op.node_voltages[pick.minus]?.toFixed(4)} V
        </div>
      )}
    </div>
  );
}

function PreviousResult({ stored, circuit }: {
  stored: StoredResult;
  circuit: Circuit;
}) {
  const r = stored.result;
  const nameOf = (id: string) => circuit.nodes.find((n) => n.id === id)?.name ?? id;
  return (
    <details className="card previous" open>
      <summary>
        上一次成功的结果（仅供比较，<b>不是</b>当前电路的计算状态）
        <span className="tag stale-tag">旧 hash {stored.hash.slice(0, 8)}</span>
      </summary>
      {r.operating_point && (
        <div className="mini-op">
          {Object.entries(r.operating_point.node_voltages).map(([id, v]) => (
            <span key={id} className="mini-chip">
              {nameOf(id)}: {v.toFixed(4)} V
            </span>
          ))}
        </div>
      )}
      {r.frequency_response &&
        Object.entries(r.frequency_response.probes).map(([pid, p]) => {
          const i = Math.floor(p.gain_db.length / 2);
          return (
            <div key={pid} className="mini-curve">
              {p.name}（+{nameOf(p.plus)}/−{nameOf(p.minus)}）@{" "}
              {r.frequency_response!.freqs[i].toPrecision(3)} Hz：{p.gain_db[i].toFixed(2)} dB
            </div>
          );
        })}
    </details>
  );
}
