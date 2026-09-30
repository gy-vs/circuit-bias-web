import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import { SymbolShape, localPins, pinWorldPosition } from "../symbols";
import type { CircuitDocument, DeviceInstance, EndpointRef } from "../types";
import { formatAmps, formatEng, formatVolts } from "../util/format";

interface Viewport { scale: number; tx: number; ty: number }

interface DragState {
  kind: "device" | "junction" | "pin" | "pan" | "wire-ghost" | "probe-ghost";
  id?: string;
  start?: EndpointRef;
  startScreen?: { x: number; y: number };
  moved?: boolean;
}

const epId = (e: EndpointRef) => JSON.stringify(e);
const parseEp = (s: string | null): EndpointRef | null => {
  if (!s) return null;
  try { return JSON.parse(s) as EndpointRef; } catch { return null; }
};

export function endpointPoint(doc: CircuitDocument, e: EndpointRef): { x: number; y: number } | null {
  if (e.kind === "junction") {
    const j = doc.junctions.find((x) => x.id === e.junction);
    return j ? { x: j.x, y: j.y } : null;
  }
  const d = doc.devices.find((x) => x.id === e.device);
  if (!d) return null;
  return pinWorldPosition(d, e.pin);
}

function pinNormal(dev: DeviceInstance, pinId: string): { x: number; y: number } {
  const isVertical = dev.type === "voltage_source" || dev.type === "diode";
  let nx = 0, ny = 0;
  if (isVertical) ny = pinId === "n1" ? -1 : 1;
  else nx = pinId === "n1" ? -1 : 1;
  const rad = (dev.rotation * Math.PI) / 180;
  const c = Math.cos(rad), s = Math.sin(rad);
  return { x: nx * c - ny * s, y: nx * s + ny * c };
}

/** Orthogonal-ish routing; purely visual, recomputed from current geometry. */
function routeWire(doc: CircuitDocument, a: EndpointRef, b: EndpointRef): string {
  const S = endpointPoint(doc, a);
  const T = endpointPoint(doc, b);
  if (!S || !T) return "";
  const pts: { x: number; y: number }[] = [S];

  const pinSide = (e: EndpointRef, other: { x: number; y: number }) => {
    if (e.kind !== "pin") return null;
    const dev = doc.devices.find((d) => d.id === e.device)!;
    const P = endpointPoint(doc, e)!;
    const n = pinNormal(dev, e.pin);
    const s1 = { x: P.x + n.x * 12, y: P.y + n.y * 12 };
    pts.push(s1);
    if (Math.abs(n.x) > Math.abs(n.y)) {
      pts.push({ x: other.x, y: s1.y });
    } else {
      pts.push({ x: s1.x, y: other.y });
    }
    return null;
  };

  if (a.kind === "pin" && b.kind === "pin") {
    const da = doc.devices.find((d) => d.id === (a as Extract<EndpointRef, { kind: "pin" }>).device)!;
    const db = doc.devices.find((d) => d.id === (b as Extract<EndpointRef, { kind: "pin" }>).device)!;
    const nA = pinNormal(da, (a as Extract<EndpointRef, { kind: "pin" }>).pin);
    const nB = pinNormal(db, (b as Extract<EndpointRef, { kind: "pin" }>).pin);
    const s1 = { x: S.x + nA.x * 12, y: S.y + nA.y * 12 };
    const t1 = { x: T.x + nB.x * 12, y: T.y + nB.y * 12 };
    pts.push(s1);
    if (Math.abs(nA.x) > Math.abs(nA.y)) {
      const my = (s1.y + t1.y) / 2;
      pts.push({ x: s1.x, y: my }, { x: t1.x, y: my });
    } else {
      const mx = (s1.x + t1.x) / 2;
      pts.push({ x: mx, y: s1.y }, { x: mx, y: t1.y });
    }
    pts.push(t1);
  } else if (a.kind === "pin") {
    pinSide(a, T);
  } else if (b.kind === "pin") {
    // route from T toward S, then reverse
    const tmp: { x: number; y: number }[] = [];
    const old = pts.splice(0);
    void old;
    const dev = doc.devices.find((d) => d.id === (b as Extract<EndpointRef, { kind: "pin" }>).device)!;
    const n = pinNormal(dev, (b as Extract<EndpointRef, { kind: "pin" }>).pin);
    const t1 = { x: T.x + n.x * 12, y: T.y + n.y * 12 };
    if (Math.abs(n.x) > Math.abs(n.y)) tmp.push(S, { x: t1.x, y: S.y }, t1);
    else tmp.push(S, { x: S.x, y: t1.y }, t1);
    tmp.forEach((p) => pts.push(p));
  }
  pts.push(T);
  return "M " + pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" L ");
}

export function Canvas() {
  const svgRef = useRef<SVGSVGElement>(null);
  const [view, setView] = useState<Viewport>({ scale: 1, tx: 60, ty: 30 });
  const drag = useRef<DragState | null>(null);
  const suppressClick = useRef(false);
  const [ghost, setGhost] = useState<{ from: EndpointRef; x: number; y: number } | null>(null);
  const [dragPinEp, setDragPinEp] = useState<EndpointRef | null>(null);
  const [probeDraft, setProbeDraft] = useState<EndpointRef | null>(null);

  const doc = useStore((s) => s.doc);
  const selection = useStore((s) => s.selection);
  const tool = useStore((s) => s.tool);
  const status = useStore((s) => s.status);
  const result = useStore((s) => s.result);
  const resultHash = useStore((s) => s.resultHash);
  const currentHash = useStore((s) => s.currentHash);
  const markedProbe = useStore((s) => s.markedProbe);

  const fresh = status === "ok" && result?.status === "ok" && resultHash === currentHash && currentHash !== null;
  const op = fresh ? result!.operating_point : null;

  const toWorld = useCallback((clientX: number, clientY: number) => {
    const rect = svgRef.current!.getBoundingClientRect();
    return {
      x: (clientX - rect.left - view.tx) / view.scale,
      y: (clientY - rect.top - view.ty) / view.scale,
    };
  }, [view]);

  const errorRefs = useMemo(() => {
    const devs = new Set<string>();
    const nodes = new Set<string>();
    const probes = new Set<string>();
    result?.diagnostics.forEach((d) => {
      if (d.ref_type === "device" && d.ref_id) devs.add(d.ref_id);
      if (d.ref_type === "node" && d.ref_id) nodes.add(d.ref_id);
      if (d.ref_type === "probe" && d.ref_id) probes.add(d.ref_id);
    });
    return { devs, nodes, probes };
  }, [result]);

  const probeNodeSet = useMemo(() => {
    if (!markedProbe) return new Set<string>();
    const p = doc.probes.find((x) => x.id === markedProbe);
    const set = new Set<string>();
    p?.plus.kind === "junction" && set.add(p.plus.junction);
    p?.minus.kind === "junction" && set.add(p.minus.junction);
    return set;
  }, [markedProbe, doc.probes]);

  // ---- pointer handlers --------------------------------------------------

  const onBackgroundDown = (ev: React.PointerEvent) => {
    useStore.getState().select(null);
    drag.current = {
      kind: "pan",
      startScreen: { x: ev.clientX - view.tx, y: ev.clientY - view.ty },
    };
    (ev.target as Element).setPointerCapture?.(ev.pointerId);
  };

  const onMove = (ev: React.PointerEvent) => {
    const st = drag.current;
    if (!st) return;
    const w = toWorld(ev.clientX, ev.clientY);
    st.moved = true;
    if (st.kind === "pan") {
      setView((v) => ({
        ...v,
        tx: ev.clientX - st.startScreen!.x,
        ty: ev.clientY - st.startScreen!.y,
      }));
    } else if (st.kind === "device" && st.id) {
      useStore.getState().moveDevice(st.id, w.x, w.y);
    } else if (st.kind === "junction" && st.id) {
      useStore.getState().moveJunction(st.id, w.x, w.y);
    } else if (st.kind === "pin" && st.start) {
      setGhost({ from: st.start, x: w.x, y: w.y });
    } else if (st.kind === "wire-ghost" && st.start) {
      setGhost({ from: st.start, x: w.x, y: w.y });
    } else if (st.kind === "probe-ghost" && st.start) {
      setGhost({ from: st.start, x: w.x, y: w.y });
    }
  };

  const findEndpointTarget = (ev: React.PointerEvent): EndpointRef | null => {
    const el = document.elementFromPoint(ev.clientX, ev.clientY) as Element | null;
    const hit = el?.closest?.("[data-ep]");
    return parseEp(hit?.getAttribute("data-ep") ?? null);
  };

  const onUp = (ev: React.PointerEvent) => {
    const st = drag.current;
    suppressClick.current = !!st?.moved;
    drag.current = null;
    if (!st) return;

    if (st.kind === "pin" && st.start) {
      const target = findEndpointTarget(ev);
      setGhost(null);
      setDragPinEp(null);
      if (target && epId(target) !== epId(st.start)) {
        // Reconnect every wire currently attached to the dragged pin.
        const wires = useStore.getState().doc.wires.filter(
          (w) => epId(w.a) === epId(st.start!) || epId(w.b) === epId(st.start!));
        wires.forEach((w) => {
          useStore.getState().reconnectWireEnd(
            w.id, epId(w.a) === epId(st.start!) ? "a" : "b", target);
        });
      }
    }
    if (st.kind === "wire-ghost" && st.start) {
      const target = findEndpointTarget(ev);
      setGhost(null);
      if (target && epId(target) !== epId(st.start)) {
        useStore.getState().addWire(st.start, target);
      }
    }
    if (st.kind === "probe-ghost" && st.start) {
      const target = findEndpointTarget(ev);
      setGhost(null);
      setProbeDraft(null);
      if (target && epId(target) !== epId(st.start)) {
        const id = useStore.getState().addProbe(st.start, target);
        useStore.getState().select({ kind: "probe", id });
      }
    }
  };

  const onWheel = (ev: React.WheelEvent) => {
    const rect = svgRef.current!.getBoundingClientRect();
    const mx = ev.clientX - rect.left;
    const my = ev.clientY - rect.top;
    const factor = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
    setView((v) => {
      const scale = Math.min(3, Math.max(0.25, v.scale * factor));
      return {
        scale,
        tx: mx - (mx - v.tx) * (scale / v.scale),
        ty: my - (my - v.ty) * (scale / v.scale),
      };
    });
  };

  // background click for add/junction tools
  const onBackgroundClick = (ev: React.MouseEvent) => {
    if (suppressClick.current) { suppressClick.current = false; return; }
    const w = toWorld(ev.clientX, ev.clientY);
    const t = useStore.getState().tool;
    if (t.kind === "add") {
      const id = useStore.getState().addDeviceAt(t.device, w.x, w.y);
      useStore.getState().select({ kind: "device", id });
      useStore.getState().setTool({ kind: "select" });
    } else if (t.kind === "junction") {
      const id = useStore.getState().addJunctionAt(w.x, w.y);
      useStore.getState().select({ kind: "junction", id });
      useStore.getState().setTool({ kind: "select" });
    }
  };

  const startEndpointGesture = (ev: React.PointerEvent, ep: EndpointRef) => {
    ev.stopPropagation();
    svgRef.current?.setPointerCapture(ev.pointerId);
    if (tool.kind === "wire") {
      drag.current = { kind: "wire-ghost", start: ep };
    } else if (tool.kind === "probe") {
      drag.current = { kind: "probe-ghost", start: ep };
      setProbeDraft(ep);
    } else if (tool.kind === "select" && ep.kind === "pin") {
      drag.current = { kind: "pin", start: ep };
      setDragPinEp(ep);
    }
  };

  // keyboard rotate for selected device handled in App; escape cancels
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        drag.current = null;
        setGhost(null);
        setProbeDraft(null);
        useStore.getState().setTool({ kind: "select" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const devValueLabel = (d: DeviceInstance): string => {
    if (d.type === "resistor") return d.r !== undefined ? `${formatEng(d.r)}Ω` : "?";
    if (d.type === "capacitor") return d.c !== undefined ? `${formatEng(d.c)}F` : "?";
    if (d.type === "voltage_source") return `${d.dc ?? "?"}V / AC ${d.ac ?? 0}`;
    return `Is=${formatEng(d.isat ?? 0)}A Vt=${formatEng(d.vt ?? 0)}V`;
  };

  return (
    <div className="canvas-area">
      <svg
        ref={svgRef}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerDown={onBackgroundDown}
        onClick={onBackgroundClick}
        onWheel={onWheel}
      >
        <defs>
          <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M 40 0 L 0 0 0 40" fill="none" stroke="var(--grid)" strokeWidth="1" />
          </pattern>
        </defs>
        <rect x={-4000} y={-4000} width={8000} height={8000} fill="url(#grid)"
          transform={`translate(${view.tx},${view.ty}) scale(${view.scale})`} />

        <g transform={`translate(${view.tx},${view.ty}) scale(${view.scale})`}>
          {/* wires */}
          {doc.wires.map((w) => {
            const d = routeWire(doc, w.a, w.b);
            const isErr =
              (w.a.kind === "junction" && errorRefs.nodes.has(w.a.junction)) ||
              (w.b.kind === "junction" && errorRefs.nodes.has(w.b.junction)) ||
              (w.a.kind === "pin" && errorRefs.devs.has(w.a.device)) ||
              (w.b.kind === "pin" && errorRefs.devs.has(w.b.device));
            const hlProbe = doc.probes.find((p) => p.id === markedProbe);
            const touched = hlProbe && (
              epId(w.a) === epId(hlProbe.plus) || epId(w.a) === epId(hlProbe.minus) ||
              epId(w.b) === epId(hlProbe.plus) || epId(w.b) === epId(hlProbe.minus));
            const selected = selection?.kind === "wire" && selection.id === w.id;
            return (
              <g key={w.id}>
                <path className="wire-hit" d={d}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    useStore.getState().select({ kind: "wire", id: w.id });
                  }} />
                <path
                  className={`wire-line ${selected ? "selected" : ""} ${isErr ? "error" : ""} ${touched ? "probe-hl" : ""}`}
                  d={d} />
              </g>
            );
          })}

          {/* junctions */}
          {doc.junctions.map((j) => {
            const isGround = j.id === doc.groundJunction;
            const v = op?.node_voltages[j.id];
            const selected = selection?.kind === "junction" && selection.id === j.id;
            const isErr = errorRefs.nodes.has(j.id);
            const probeHl = probeNodeSet.has(j.id);
            return (
              <g key={j.id} transform={`translate(${j.x},${j.y})`}>
                {isGround && (
                  <g className="ground-mark" transform="translate(0,10)">
                    <line x1={0} y1={0} x2={0} y2={8} />
                    <line x1={-12} y1={8} x2={12} y2={8} />
                    <line x1={-8} y1={14} x2={8} y2={14} />
                    <line x1={-4} y1={20} x2={4} y2={20} />
                  </g>
                )}
                <circle
                  className={`junction-node ${isGround ? "ground" : ""} ${selected ? "selected" : ""}`}
                  r={selected ? 7 : 5.5}
                  stroke={isErr ? "var(--err)" : probeHl ? "var(--accent2)" : undefined}
                  strokeWidth={isErr || probeHl ? 3 : undefined}
                  data-ep={epId({ kind: "junction", junction: j.id })}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    const ep: EndpointRef = { kind: "junction", junction: j.id };
                    if (tool.kind === "wire" || tool.kind === "probe") startEndpointGesture(e, ep);
                    else {
                      drag.current = { kind: "junction", id: j.id };
                    }
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (tool.kind === "select") useStore.getState().select({ kind: "junction", id: j.id });
                  }}
                />
                <text className="junction-label" y={-11}>{j.name ?? j.id}{isGround ? " ⏚" : ""}</text>
                {v !== undefined && (
                  <text className="node-voltage" y={isGround ? 38 : 20}>{formatVolts(v)}</text>
                )}
              </g>
            );
          })}

          {/* devices */}
          {doc.devices.map((d) => {
            const selected = selection?.kind === "device" && selection.id === d.id;
            const isErr = errorRefs.devs.has(d.id);
            const cur = op?.device_currents[d.id];
            return (
              <g
                key={d.id}
                className={`device-body ${selected ? "device-selected" : ""} ${isErr ? "err" : ""}`}
                transform={`translate(${d.x},${d.y}) rotate(${d.rotation})`}
                style={{ pointerEvents: dragPinEp?.kind === "pin" && dragPinEp.device === d.id ? "none" : "auto" }}
                onPointerDown={(e) => {
                  if (tool.kind !== "select") return;
                  e.stopPropagation();
                  drag.current = { kind: "device", id: d.id };
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  if (tool.kind === "select" && !suppressClick.current) {
                    useStore.getState().select({ kind: "device", id: d.id });
                  }
                }}
              >
                <rect className="sel-box" x={-56} y={-34} width={112} height={68} rx={6} />
                <SymbolShape type={d.type} />
                <text className="dev-label" y={-40} transform={d.rotation ? `rotate(${-d.rotation})` : undefined}>
                  {d.name ?? d.id}
                </text>
                <text className="dev-value" y={38}
                  transform={d.rotation ? `rotate(${-d.rotation})` : undefined}>
                  {devValueLabel(d)}
                </text>
                {cur !== undefined && (
                  <text className="dev-current" y={-28}
                    transform={d.rotation ? `rotate(${-d.rotation})` : undefined}>
                    I={formatAmps(cur)}
                  </text>
                )}
                {localPins(d.type).map((p) => (
                  <circle
                    key={p.id}
                    className="pin-hit"
                    cx={p.x} cy={p.y} r={11}
                    data-ep={epId({ kind: "pin", device: d.id, pin: p.id })}
                    onPointerDown={(e) => startEndpointGesture(e, { kind: "pin", device: d.id, pin: p.id })}
                    onClick={(e) => e.stopPropagation()}
                  />
                ))}
              </g>
            );
          })}

          {/* probe markers */}
          {doc.probes.map((p) => {
            const pos = endpointPoint(doc, p.plus);
            if (!pos) return null;
            const selected = selection?.kind === "probe" && selection.id === p.id;
            const isErr = errorRefs.probes.has(p.id);
            return (
              <g key={p.id} className="probe-marker"
                transform={`translate(${pos.x + 14},${pos.y - 26})`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  useStore.getState().select({ kind: "probe", id: p.id });
                  useStore.getState().markPlotPoint(p.id, useStore.getState().markedFreq);
                }}
              >
                <circle r={9} fill="var(--panel2)"
                  stroke={isErr ? "var(--err)" : selected || markedProbe === p.id ? "var(--accent2)" : "var(--accent2)"}
                  strokeWidth={selected ? 2.5 : 1.4} />
                <text className="probe-tag" textAnchor="middle" y={3.5}>V</text>
                <text className="probe-tag" x={12} y={3.5}>{p.name ?? p.id}</text>
              </g>
            );
          })}

          {/* wire / probe ghost preview */}
          {ghost && (() => {
            const from = endpointPoint(doc, ghost.from) ?? { x: ghost.x, y: ghost.y };
            return (
              <line className="wire-preview"
                x1={from.x} y1={from.y} x2={ghost.x} y2={ghost.y}
                style={{ pointerEvents: "none" }} />
            );
          })()}
        </g>
      </svg>
      <div style={{ position: "absolute", right: 10, bottom: 8 }} className="muted">
        {tool.kind === "wire" && "连线：依次点击两个端子/节点（Esc 取消）"}
        {tool.kind === "probe" && (probeDraft ? "再点一个端子作为探针负端" : "电压探针：先点正端")}
        {tool.kind === "add" && `点击画布放置 ${tool.device}`}
        {tool.kind === "junction" && "点击画布放置连接节点"}
        {tool.kind === "select" && "滚轮缩放 · 空白拖动平移 · 拖动器件端子可改接"}
      </div>
    </div>
  );
}
