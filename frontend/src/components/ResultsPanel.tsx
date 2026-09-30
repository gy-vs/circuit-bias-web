import { useMemo, useState } from "react";
import { useStore } from "../store";
import { compile } from "../compiler";
import type { AnalysisResult } from "../types";
import { formatAmps, formatEng, formatFreq, formatVolts } from "../util/format";

function locate(refType: string | null, refId: string | null) {
  const store = useStore.getState();
  if (!refType || !refId) return;
  if (refType === "device" && store.doc.devices.some((d) => d.id === refId)) {
    store.select({ kind: "device", id: refId });
  } else if (refType === "node" && store.doc.junctions.some((j) => j.id === refId)) {
    store.select({ kind: "junction", id: refId });
  } else if (refType === "probe" && store.doc.probes.some((p) => p.id === refId)) {
    store.select({ kind: "probe", id: refId });
  } else if (refType === "source" && store.doc.devices.some((d) => d.id === refId)) {
    store.select({ kind: "device", id: refId });
  }
}

function Diagnostics({ result }: { result: AnalysisResult | null }) {
  const compileIssues = useStore((s) => s.compileIssues);
  const diags = result?.diagnostics ?? [];
  if (diags.length === 0 && compileIssues.length === 0) return null;
  return (
    <section>
      <h2>诊断</h2>
      {diags.map((d, i) => (
        <div key={`s${i}`} className={`diag ${d.severity}`}
          onClick={() => locate(d.ref_type, d.ref_id)}>
          <span className="ico">{d.severity === "error" ? "✕" : "!"}</span>
          <div>
            <div>{d.message}</div>
            {d.ref_id && (
              <div className="muted">
                关联{d.ref_type === "device" ? "器件" : d.ref_type === "node" ? "节点"
                  : d.ref_type === "probe" ? "探针" : "输入源"}：{d.ref_id}（点击定位）
              </div>
            )}
          </div>
        </div>
      ))}
      {diags.length === 0 && compileIssues.map((iss, i) => (
        <div key={`c${i}`} className="diag warning"
          onClick={() => iss.ref && locate(iss.ref.type, iss.ref.id)}>
          <span className="ico">!</span>
          <div>
            {iss.message}
            {iss.ref && <div className="muted">（点击定位到{iss.ref.type === "device" ? "器件" : "节点"}）</div>}
          </div>
        </div>
      ))}
    </section>
  );
}

function OperatingPointTable({ result }: { result: AnalysisResult }) {
  const doc = useStore((s) => s.doc);
  const op = result.operating_point!;
  return (
    <section>
      <h2>工作点</h2>
      <table className="dc-table">
        <tbody>
          {Object.entries(op.node_voltages).map(([nid, v]) => (
            <tr key={nid} className="clickable" onClick={() => locate("node", nid)}>
              <td>节点 {doc.junctions.find((j) => j.id === nid)?.name ?? nid}</td>
              <td className="num">{formatVolts(v)}</td>
            </tr>
          ))}
          {Object.entries(op.device_currents).map(([did, i]) => {
            const d = doc.devices.find((x) => x.id === did);
            return (
              <tr key={did} className="clickable" onClick={() => locate("device", did)}>
                <td>I({d?.name ?? did}) <span className="muted">流入 n1</span></td>
                <td className="num">{formatAmps(i)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {Object.keys(op.diode_vj).length > 0 && (
        <div className="muted" style={{ marginTop: 6 }}>
          {Object.entries(op.diode_vj).map(([did, vj]) =>
            `${did}: Vj=${vj.toFixed(4)}V, gd=${formatEng(op.diode_gd[did])}S`).join(" · ")}
        </div>
      )}
    </section>
  );
}

const W = 300, H = 170, M = { l: 42, r: 8, t: 8, b: 22 };

function BodeChart({
  ac, probeId, mode, baselineAc,
}: {
  ac: NonNullable<AnalysisResult["ac"]>;
  probeId: string;
  mode: "mag" | "phase";
  baselineAc?: AnalysisResult["ac"] | null;
}) {
  const markedFreq = useStore((s) => s.markedFreq);
  const mark = useStore((s) => s.markPlotPoint);
  const probe = ac.probes[probeId];
  if (!probe) return null;
  const freqs = ac.frequencies;
  const lx = Math.log10(freqs[0]);
  const rx = Math.log10(freqs[freqs.length - 1]);
  const data = mode === "mag" ? probe.magnitude_db : probe.phase_deg;
  const lo = mode === "mag" ? Math.min(...data) : -180;
  const hi = mode === "mag" ? Math.max(...data, 0) : 180;
  const span = Math.max(hi - lo, 1e-6);
  const x = (f: number) => M.l + ((Math.log10(f) - lx) / (rx - lx)) * (W - M.l - M.r);
  const y = (v: number) => M.t + (1 - (v - lo) / span) * (H - M.t - M.b);

  const path = data.map((v, i) => `${i ? "L" : "M"}${x(freqs[i]).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const baseProbe = baselineAc?.probes[probeId];
  const basePath = baseProbe && mode === "mag"
    ? baselineAc!.frequencies.map((f, i) => {
        const v = baseProbe.magnitude_db[i];
        return `${i ? "L" : "M"}${x(f).toFixed(1)},${y(v).toFixed(1)}`;
      }).join("")
    : null;

  const markIdx = markedFreq !== null
    ? freqs.reduce((best, f, i) =>
      Math.abs(Math.log10(f) - Math.log10(markedFreq)) <
        Math.abs(Math.log10(freqs[best]) - Math.log10(markedFreq)) ? i : best, 0)
    : null;

  const ticks: number[] = [];
  for (let e = Math.ceil(lx); e <= Math.floor(rx); e++) ticks.push(e);

  return (
    <svg viewBox={`0 0 ${W} ${H}`}
      onPointerMove={(e) => {
        const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
        const px = ((e.clientX - rect.left) / rect.width) * W;
        const frac = (px - M.l) / (W - M.l - M.r);
        if (frac < 0 || frac > 1) return;
        mark(probeId, Math.pow(10, lx + frac * (rx - lx)));
      }}
      onPointerLeave={() => mark(null, null)}
    >
      <rect x={M.l} y={M.t} width={W - M.l - M.r} height={H - M.t - M.b} fill="#0003" />
      {ticks.map((e) => (
        <g key={e}>
          <line x1={x(10 ** e)} y1={M.t} x2={x(10 ** e)} y2={H - M.b} stroke="#ffffff0c" />
          <text x={x(10 ** e)} y={H - 6} fontSize={8.5} fill="var(--ink-dim)" textAnchor="middle">
            {formatFreq(10 ** e)}
          </text>
        </g>
      ))}
      {[0, 0.5, 1].map((q) => {
        const v = lo + q * span;
        return (
          <g key={q}>
            <line x1={M.l} y1={y(v)} x2={W - M.r} y2={y(v)} stroke="#ffffff08" />
            <text x={M.l - 4} y={y(v) + 3} fontSize={8.5} fill="var(--ink-dim)" textAnchor="end">
              {v.toFixed(0)}
            </text>
          </g>
        );
      })}
      {basePath && <path d={basePath} fill="none" stroke="var(--stale)" strokeWidth={1.2} strokeDasharray="4 3" />}
      <path d={path} fill="none" stroke="var(--accent)" strokeWidth={1.8} />
      {markIdx !== null && (
        <g>
          <line x1={x(freqs[markIdx])} y1={M.t} x2={x(freqs[markIdx])} y2={H - M.b}
            stroke="var(--accent2)" strokeDasharray="2 2" />
          <circle cx={x(freqs[markIdx])} cy={y(data[markIdx])} r={3.5} fill="var(--accent2)" />
          <text x={W - M.r} y={M.t + 9} fontSize={9} fill="var(--accent2)" textAnchor="end">
            {formatFreq(freqs[markIdx])} · {data[markIdx].toFixed(2)}{mode === "mag" ? " dB" : "°"}
          </text>
        </g>
      )}
    </svg>
  );
}

function ProbeBlock({
  probeId, fresh, result, baseline,
}: {
  probeId: string;
  fresh: boolean;
  result: AnalysisResult;
  baseline: { result: AnalysisResult; hash: string } | null;
}) {
  const [mode, setMode] = useState<"mag" | "phase">("mag");
  const doc = useStore((s) => s.doc);
  const ac = result.ac!;
  const probe = ac.probes[probeId];
  const markedFreq = useStore((s) => s.markedFreq);
  if (!probe) return null;
  const name = doc.probes.find((p) => p.id === probeId)?.name ?? probeId;
  const idx = markedFreq !== null
    ? ac.frequencies.reduce((b, f, i) =>
      Math.abs(Math.log10(f) - Math.log10(markedFreq)) <
        Math.abs(Math.log10(ac.frequencies[b]) - Math.log10(markedFreq)) ? i : b, 0)
    : null;
  return (
    <section>
      <div className="row-between">
        <h2 style={{ margin: 0 }}>
          探针 {name}{" "}
          <span className="pill">V({probe.n_plus}) − V({probe.n_minus})</span>
        </h2>
        <div className="muted">输入 {ac.input_source}（AC {formatEng(ac.input_ac)}V）</div>
      </div>
      <div className="row-between" style={{ margin: "6px 0" }}>
        <div style={{ display: "flex", gap: 4 }}>
          <button className={`btn ${mode === "mag" ? "primary" : ""}`} onClick={() => setMode("mag")}>幅度 dB</button>
          <button className={`btn ${mode === "phase" ? "primary" : ""}`} onClick={() => setMode("phase")}>相位 °</button>
        </div>
        <button className="btn"
          onClick={() => useStore.getState().select({ kind: "probe", id: probeId })}>
          在图中定位
        </button>
      </div>
      <div className="chart-wrap">
        <BodeChart ac={ac} probeId={probeId} mode={mode}
          baselineAc={baseline?.result.ac ?? null} />
      </div>
      {idx !== null && (
        <div className="muted mono">
          f={formatFreq(ac.frequencies[idx])} → {probe.magnitude_db[idx].toFixed(3)} dB,
          {" "}{probe.phase_deg[idx].toFixed(2)}°
          {!fresh && <span style={{ color: "var(--stale)" }}>（上一次成功计算，非当前电路）</span>}
        </div>
      )}
    </section>
  );
}

export function ResultsPanel() {
  const doc = useStore((s) => s.doc);
  const status = useStore((s) => s.status);
  const result = useStore((s) => s.result);
  const resultHash = useStore((s) => s.resultHash);
  const currentHash = useStore((s) => s.currentHash);
  const baseline = useStore((s) => s.baseline);
  const lastGood = useStore((s) => s.lastGood);
  const localError = useStore((s) => s.localError);
  const keepBaseline = useStore((s) => s.keepBaseline);
  const clearBaseline = useStore((s) => s.clearBaseline);

  const compiled = useMemo(() => compile(doc), [doc]);
  const fresh = status === "ok" && result?.status === "ok" && resultHash === currentHash && currentHash !== null;
  const running = status === "running";
  const errored = status === "error";

  const shown: { result: AnalysisResult; hash: string; kind: "fresh" | "old" } | null = fresh
    ? { result: result!, hash: resultHash!, kind: "fresh" }
    : (errored || running) && lastGood && lastGood.hash !== currentHash
      ? { result: lastGood.result, hash: lastGood.hash, kind: "old" }
      : result && resultHash && resultHash !== currentHash
        ? { result, hash: resultHash, kind: "old" }
        : null;

  return (
    <>
      {running && (
        <div className="banner running">
          <span className="dot" style={{ width: 7, height: 7, borderRadius: "50%", background: "currentColor" }} />
          正在对当前电路求解…{shown?.kind === "old" && "（下方仍为上一次成功结果）"}
        </div>
      )}
      {!running && errored && (
        <div className="banner error">✕ 当前电路计算失败 —— 下方任何曲线都不是当前电路的结果</div>
      )}
      {!running && !errored && shown?.kind === "old" && (
        <div className="banner stale">
          ◷ 上一次成功结果（{shown.hash.slice(0, 8)}）；当前电路（{currentHash?.slice(0, 8)}）尚未对应
        </div>
      )}
      {fresh && (
        <div className="banner" style={{ background: "#12261b", color: "#9fe6c0" }}>
          ✓ 计算完成，结果与当前电路一致（{result!.meta?.newton_iterations} 次 Newton 迭代）
        </div>
      )}

      {localError && (
        <section>
          <div className="diag error"><span className="ico">✕</span><div>{localError}</div></div>
        </section>
      )}

      <Diagnostics result={result} />

      {baseline && (
        <section>
          <div className="baseline-box">
            <div className="row-between">
              <span className="tag">对比基线（旧偏置 {baseline.hash.slice(0, 8)}）</span>
              <button className="btn" onClick={clearBaseline}>清除</button>
            </div>
            <div className="muted" style={{ marginTop: 4 }}>
              紫色虚线来自之前保留的一次成功计算；它不会被标记为当前结果。
            </div>
          </div>
        </section>
      )}

      {shown?.kind === "old" && (
        <section>
          <div className="muted">
            以下为<span style={{ color: "var(--stale)" }}> 上一次成功 </span>
            的工作点与响应（{shown.hash.slice(0, 8)}），供比较：
          </div>
        </section>
      )}

      {shown && shown.result.operating_point && (
        <OperatingPointTable result={shown.result} />
      )}
      {shown && shown.result.ac && Object.keys(shown.result.ac.probes).map((pid) => (
        <ProbeBlock
          key={pid}
          probeId={pid}
          fresh={shown!.kind === "fresh"}
          result={shown!.result}
          baseline={baseline}
        />
      ))}

      {fresh && (
        <section>
          <button className="btn" onClick={keepBaseline}>把当前结果保留为对比基线</button>
        </section>
      )}

      {!shown && !running && (
        <section><div className="empty-hint">当前电路还没有有效结果。</div></section>
      )}

      {fresh && (!doc.inputSource || doc.probes.length === 0) && (
        <section>
          <div className="empty-hint">
            {!doc.inputSource && "未选择输入源，"}
            {doc.probes.length === 0 && "还没有电压探针；"}
            在工具栏选“探针”工具，依次点击正、负两个节点即可添加。
          </div>
        </section>
      )}
      <section>
        <div className="muted">
          本次电气输入含 {compiled.api.nodes.length} 个求解节点、
          {compiled.api.devices.length} 个器件。位置变化不会出现在输入里。
        </div>
      </section>
    </>
  );
}
