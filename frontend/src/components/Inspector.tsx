import { useState } from "react";
import { useStore } from "../store";
import type { DeviceInstance, EndpointRef } from "../types";
import { parseValue } from "../util/format";

function ParamField({
  label, unit, value, onChange,
}: { label: string; unit: string; value: number | undefined; onChange: (v: number) => void }) {
  const [text, setText] = useState(value !== undefined ? String(value) : "");
  const [bad, setBad] = useState(false);
  const parsed = parseValue(text);
  const commit = () => {
    const v = parseValue(text);
    if (v !== null) { onChange(v); setBad(false); }
    else setBad(true);
  };
  return (
    <div className="field">
      <label>{label}</label>
      <input
        value={text}
        style={{ borderColor: bad ? "var(--err)" : parsed !== null && parsed !== value ? "var(--accent2)" : undefined }}
        onChange={(e) => { setText(e.target.value); setBad(false); }}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      />
      <span className="muted" style={{ flex: "0 0 24px" }}>{unit}</span>
    </div>
  );
}

function TerminalSelect({ deviceId, pin, label }: { deviceId: string; pin: "n1" | "n2"; label: string }) {
  const doc = useStore((s) => s.doc);
  const ep: EndpointRef = { kind: "pin", device: deviceId, pin };
  const epKey = JSON.stringify(ep);
  const wires = doc.wires.filter((w) => JSON.stringify(w.a) === epKey || JSON.stringify(w.b) === epKey);
  const currentJunction = wires
    .map((w) => (w.a.kind === "junction" ? w.a.junction : w.b.kind === "junction" ? w.b.junction : null))
    .find((x): x is string => !!x) ?? "";

  return (
    <div className="field">
      <label>{label}</label>
      <select
        value={currentJunction}
        onChange={(e) => {
          const store = useStore.getState();
          const attached = store.doc.wires.filter(
            (w) => JSON.stringify(w.a) === epKey || JSON.stringify(w.b) === epKey);
          if (e.target.value === "") {
            attached.forEach((w) => store.deleteWire(w.id));
            return;
          }
          const target: EndpointRef = { kind: "junction", junction: e.target.value };
          if (attached.length === 0) store.addWire(ep, target);
          else attached.forEach((w) =>
            store.reconnectWireEnd(w.id, JSON.stringify(w.a) === epKey ? "a" : "b", target));
        }}
      >
        <option value="">（悬空）</option>
        {doc.junctions.map((j) => (
          <option key={j.id} value={j.id}>{j.name ?? j.id}</option>
        ))}
      </select>
    </div>
  );
}

function DeviceEditor({ dev }: { dev: DeviceInstance }) {
  const update = useStore((s) => s.updateDevice);
  const rotate = useStore((s) => s.rotateDevice);
  return (
    <section>
      <h2>器件 {dev.type}</h2>
      <div className="field">
        <label>名称</label>
        <input value={dev.name ?? ""} onChange={(e) => update(dev.id, { name: e.target.value })} />
      </div>
      {dev.type === "resistor" && (
        <ParamField label="阻值" unit="Ω" value={dev.r} onChange={(v) => update(dev.id, { r: v })} />
      )}
      {dev.type === "capacitor" && (
        <ParamField label="容值" unit="F" value={dev.c} onChange={(v) => update(dev.id, { c: v })} />
      )}
      {dev.type === "voltage_source" && (<>
        <ParamField label="DC 电压" unit="V" value={dev.dc} onChange={(v) => update(dev.id, { dc: v })} />
        <ParamField label="AC 幅度" unit="V" value={dev.ac} onChange={(v) => update(dev.id, { ac: v })} />
      </>)}
      {dev.type === "diode" && (<>
        <ParamField label="Is" unit="A" value={dev.isat} onChange={(v) => update(dev.id, { isat: v })} />
        <ParamField label="热电压" unit="V" value={dev.vt} onChange={(v) => update(dev.id, { vt: v })} />
      </>)}
      <TerminalSelect deviceId={dev.id} pin="n1" label="端子 n1" />
      <TerminalSelect deviceId={dev.id} pin="n2" label="端子 n2" />
      <button className="btn" onClick={() => rotate(dev.id)}>旋转 90°</button>
      <span className="muted" style={{ marginLeft: 10 }}>
        {dev.type === "diode" ? "n1=阳极 n2=阴极" : dev.type === "voltage_source" ? "n1=+ n2=−" : ""}
      </span>
    </section>
  );
}

function JunctionEditor({ id }: { id: string }) {
  const doc = useStore((s) => s.doc);
  const rename = useStore((s) => s.renameJunction);
  const setGround = useStore((s) => s.setGround);
  const result = useStore((s) => s.result);
  const currentHash = useStore((s) => s.currentHash);
  const resultHash = useStore((s) => s.resultHash);
  const status = useStore((s) => s.status);
  const j = doc.junctions.find((x) => x.id === id);
  if (!j) return null;
  const fresh = status === "ok" && result?.status === "ok" && resultHash === currentHash;
  const v = fresh ? result!.operating_point!.node_voltages[id] : undefined;
  return (
    <section>
      <h2>节点</h2>
      <div className="field">
        <label>节点名</label>
        <input value={j.name ?? ""} onChange={(e) => rename(id, e.target.value)} />
      </div>
      <div className="field">
        <label>参考地</label>
        <input type="radio" checked={doc.groundJunction === id}
          onChange={() => setGround(id)} style={{ flex: "none" }} />
      </div>
      <div className="muted">直流电位：{v !== undefined ? `${v.toFixed(6)} V` : "（当前无有效结果）"}</div>
    </section>
  );
}

function WireEditor({ id }: { id: string }) {
  const doc = useStore((s) => s.doc);
  const deleteWire = useStore((s) => s.deleteWire);
  const w = doc.wires.find((x) => x.id === id);
  if (!w) return null;
  const epName = (e: EndpointRef) =>
    e.kind === "junction"
      ? `节点 ${doc.junctions.find((j) => j.id === e.junction)?.name ?? e.junction}`
      : `器件 ${e.device} 的 ${e.pin}`;
  return (
    <section>
      <h2>导线</h2>
      <div className="muted" style={{ marginBottom: 8 }}>
        {epName(w.a)} ↔ {epName(w.b)}
      </div>
      <button className="btn" onClick={() => { deleteWire(id); useStore.getState().select(null); }}>
        删除导线
      </button>
    </section>
  );
}

function ProbeEditor({ id }: { id: string }) {
  const doc = useStore((s) => s.doc);
  const updateEnd = useStore((s) => s.updateProbeEnd);
  const del = useStore((s) => s.deleteProbe);
  const p = doc.probes.find((x) => x.id === id);
  if (!p) return null;
  const val = (e: EndpointRef) => (e.kind === "junction" ? e.junction : "");
  const pick = (jid: string): EndpointRef => ({ kind: "junction", junction: jid });
  return (
    <section>
      <h2>电压探针</h2>
      <div className="field">
        <label>名称</label>
        <input value={p.name ?? ""}
          onChange={(e) => useStore.getState().renameProbe(id, e.target.value)} />
      </div>
      <div className="field">
        <label>正 (+) 节点</label>
        <select value={val(p.plus)} onChange={(e) => updateEnd(id, "plus", pick(e.target.value))}>
          {doc.junctions.map((j) => <option key={j.id} value={j.id}>{j.name ?? j.id}</option>)}
        </select>
      </div>
      <div className="field">
        <label>负 (−) 节点</label>
        <select value={val(p.minus)} onChange={(e) => updateEnd(id, "minus", pick(e.target.value))}>
          {doc.junctions.map((j) => <option key={j.id} value={j.id}>{j.name ?? j.id}</option>)}
        </select>
      </div>
      <button className="btn" onClick={() => { del(id); useStore.getState().select(null); }}>删除探针</button>
    </section>
  );
}

function CircuitEditor() {
  const doc = useStore((s) => s.doc);
  const setInput = useStore((s) => s.setInputSource);
  const updateSweep = useStore((s) => s.updateSweep);
  const sources = doc.devices.filter((d) => d.type === "voltage_source");
  return (
    <section>
      <h2>电路设置</h2>
      <div className="field">
        <label>输入源</label>
        <select value={doc.inputSource ?? ""} onChange={(e) => setInput(e.target.value || undefined)}>
          <option value="">（无 AC 分析）</option>
          {sources.map((d) => <option key={d.id} value={d.id}>{d.name ?? d.id}</option>)}
        </select>
      </div>
      <div className="field">
        <label>起始频率</label>
        <input type="number" value={doc.sweep.start}
          onChange={(e) => updateSweep({ start: Number(e.target.value) })} />
      </div>
      <div className="field">
        <label>终止频率</label>
        <input type="number" value={doc.sweep.stop}
          onChange={(e) => updateSweep({ stop: Number(e.target.value) })} />
      </div>
      <div className="field">
        <label>点/十倍频</label>
        <input type="number" value={doc.sweep.points_per_decade}
          onChange={(e) => updateSweep({ points_per_decade: Math.max(2, Number(e.target.value)) })} />
      </div>
      <div className="muted">
        {doc.junctions.length} 个节点 · {doc.devices.length} 个器件 · {doc.wires.length} 根导线
      </div>
    </section>
  );
}

export function Inspector() {
  const selection = useStore((s) => s.selection);
  const doc = useStore((s) => s.doc);
  const del = useStore((s) => s.deleteSelection);
  return (
    <>
      {selection?.kind === "device" && doc.devices.some((d) => d.id === selection.id) && (
        <DeviceEditor dev={doc.devices.find((d) => d.id === selection.id)!} />
      )}
      {selection?.kind === "junction" && <JunctionEditor id={selection.id} />}
      {selection?.kind === "wire" && <WireEditor id={selection.id} />}
      {selection?.kind === "probe" && <ProbeEditor id={selection.id} />}
      {!selection && <CircuitEditor />}
      {selection && (
        <section>
          <button className="btn" onClick={del} style={{ borderColor: "#7c3535", color: "var(--err)" }}>
            删除所选
          </button>
        </section>
      )}
    </>
  );
}
