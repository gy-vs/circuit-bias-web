import { useMemo } from "react";
import type {
  Circuit,
  ComponentDesc,
  Diagnostic,
  NodeDesc,
  OperatingPoint,
  Position,
} from "../types";

export type Selection =
  | { kind: "component"; id: string }
  | { kind: "node"; id: string }
  | { kind: "probe"; id: string }
  | null;

interface CanvasProps {
  circuit: Circuit;
  selection: Selection;
  diagnostics: Diagnostic[];
  op: OperatingPoint | null;
  probeIds: string[];            // probes whose curves are plotted
  onSelect: (s: Selection) => void;
  onMoveComponent: (id: string, pos: Position) => void;
  onMoveNode: (id: string, pos: Position) => void;
  onConnectTerminal: (componentId: string, terminal: 0 | 1, nodeId: string) => void;
  onProbeClickNode: (nodeId: string) => void;
}

const SYM = { w: 90, h: 46 };    // component body size
const LEAD = 22;                 // wire stub length outside body

/** Terminal coordinates in SVG space for a component. */
export function terminalPoint(c: ComponentDesc, terminal: 0 | 1): Position {
  const p = c.position ?? { x: 0, y: 0 };
  const vertical = c.orientation === "vertical";
  const len = SYM.w / 2 + LEAD;
  if (vertical) {
    return terminal === 0 ? { x: p.x, y: p.y - len } : { x: p.x, y: p.y + len };
  }
  return terminal === 0 ? { x: p.x - len, y: p.y } : { x: p.x + len, y: p.y };
}

function nodePosition(node: NodeDesc, circuit: Circuit): Position {
  if (node.position) return node.position;
  // default: sit on the first terminal that references this node
  for (const c of circuit.components) {
    const t = c.nodes.indexOf(node.id);
    if (t >= 0) return terminalPoint(c, t as 0 | 1);
  }
  return { x: 100, y: 100 };
}

const TYPE_COLOR: Record<string, string> = {
  resistor: "#3b82f6",
  capacitor: "#8b5cf6",
  voltage_source: "#059669",
  diode: "#d97706",
};

export function CircuitCanvas(props: CanvasProps) {
  const { circuit, selection, diagnostics, op } = props;

  const nodePos = useMemo(() => {
    const m = new Map<string, Position>();
    for (const n of circuit.nodes) m.set(n.id, nodePosition(n, circuit));
    return m;
  }, [circuit.nodes, circuit.components]);

  const errorNodes = new Set<string>();
  const errorComponents = new Set<string>();
  const warnComponents = new Set<string>();
  for (const d of diagnostics) {
    d.nodes?.forEach((n) => errorNodes.add(n));
    d.components?.forEach((c) => {
      if (d.severity === "error") errorComponents.add(c);
      else warnComponents.add(c);
    });
    d.probes?.forEach(() => undefined);
  }

  // wires from each terminal to the referenced node dot
  const wires: { x1: number; y1: number; x2: number; y2: number; key: string }[] = [];
  for (const c of circuit.components) {
    for (const t of [0, 1] as const) {
      const ref = c.nodes[t];
      const a = terminalPoint(c, t);
      const b = ref ? nodePos.get(ref) : undefined;
      if (b) wires.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, key: `${c.id}:${t}` });
    }
  }

  function dragComponent(e: React.PointerEvent<SVGElement>, c: ComponentDesc) {
    e.preventDefault();
    props.onSelect({ kind: "component", id: c.id });
    const start = { x: e.clientX, y: e.clientY };
    const origin = c.position ?? { x: 0, y: 0 };
    const svg = e.currentTarget.ownerSVGElement!;
    function move(ev: PointerEvent) {
      const scale = svg.getScreenCTM()?.inverse();
      const dx = (ev.clientX - start.x) * (scale?.a ?? 1);
      const dy = (ev.clientY - start.y) * (scale?.d ?? 1);
      props.onMoveComponent(c.id, { x: origin.x + dx, y: origin.y + dy });
    }
    function up() {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function dragNode(e: React.PointerEvent<SVGElement>, node: NodeDesc) {
    e.preventDefault();
    e.stopPropagation();
    props.onSelect({ kind: "node", id: node.id });
    const start = { x: e.clientX, y: e.clientY };
    const origin = nodePos.get(node.id)!;
    const svg = e.currentTarget.ownerSVGElement!;
    function move(ev: PointerEvent) {
      const scale = svg.getScreenCTM()?.inverse();
      props.onMoveNode(node.id, {
        x: origin.x + (ev.clientX - start.x) * (scale?.a ?? 1),
        y: origin.y + (ev.clientY - start.y) * (scale?.d ?? 1),
      });
    }
    function up() {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  // terminal drag -> drop on a node reconnects electrically
  function dragTerminal(e: React.PointerEvent<SVGElement>, c: ComponentDesc, terminal: 0 | 1) {
    e.preventDefault();
    e.stopPropagation();
    function up(ev: PointerEvent) {
      const target = document
        .elementFromPoint(ev.clientX, ev.clientY)
        ?.closest("[data-node-id]");
      if (target) {
        props.onConnectTerminal(c.id, terminal, target.getAttribute("data-node-id")!);
      }
      window.removeEventListener("pointerup", up);
    }
    window.addEventListener("pointerup", up);
  }

  return (
    <svg
      className="schematic"
      viewBox="0 0 1100 640"
      onPointerDown={() => props.onSelect(null)}
    >
      <defs>
        <pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse">
          <path d="M24 0H0V24" fill="none" stroke="#e5e7eb" strokeWidth="1" />
        </pattern>
      </defs>
      <rect x="0" y="0" width="1100" height="640" fill="url(#grid)" />

      {/* wires first, under symbols */}
      {wires.map((w) => (
        <line
          key={w.key}
          x1={w.x1}
          y1={w.y1}
          x2={w.x2}
          y2={w.y2}
          stroke="#475569"
          strokeWidth={2}
        />
      ))}

      {/* probe arcs between node pairs */}
      {circuit.probes.map((pr) => {
        const a = nodePos.get(pr.plus);
        const b = nodePos.get(pr.minus);
        if (!a || !b) return null;
        const active = props.probeIds.includes(pr.id);
        const selected = selection?.kind === "probe" && selection.id === pr.id;
        const mx = (a.x + b.x) / 2;
        const my = Math.min(a.y, b.y) - 34;
        return (
          <g
            key={pr.id}
            className={selected ? "probe selected" : "probe"}
            style={{ opacity: active || selected ? 1 : 0.45 }}
            onPointerDown={(e) => {
              e.stopPropagation();
              props.onSelect({ kind: "probe", id: pr.id });
            }}
          >
            <path
              d={`M${a.x},${a.y} Q${mx},${my} ${b.x},${b.y}`}
              fill="none"
              stroke={active ? "#0d9488" : "#94a3b8"}
              strokeWidth={selected ? 3 : 2}
              strokeDasharray="6 4"
            />
            <text x={mx} y={my - 4} textAnchor="middle" className="probe-label">
              {pr.name || pr.id} (+{circuit.nodes.find((n) => n.id === pr.plus)?.name ?? pr.plus}
              {" / "}−{circuit.nodes.find((n) => n.id === pr.minus)?.name ?? pr.minus})
            </text>
          </g>
        );
      })}

      {circuit.components.map((c) => (
        <ComponentGlyph
          key={c.id}
          c={c}
          selected={selection?.kind === "component" && selection.id === c.id}
          hasError={errorComponents.has(c.id)}
          hasWarning={warnComponents.has(c.id)}
          current={op?.component_currents[c.id]}
          onPointerDownBody={(e) => dragComponent(e, c)}
          onPointerDownTerminal={(e, t) => dragTerminal(e, c, t)}
        />
      ))}

      {circuit.nodes.map((node) => {
        const p = nodePos.get(node.id)!;
        const isGround = node.id === circuit.ground;
        const selected = selection?.kind === "node" && selection.id === node.id;
        const hasError = errorNodes.has(node.id);
        return (
          <g
            key={node.id}
            data-node-id={node.id}
            className="node"
            onPointerDown={(e) => dragNode(e, node)}
            onDoubleClick={() => props.onProbeClickNode(node.id)}
          >
            {isGround ? (
              <g>
                <line x1={p.x} y1={p.y} x2={p.x} y2={p.y + 16} stroke="#111827" strokeWidth={2} />
                <line x1={p.x - 14} y1={p.y + 16} x2={p.x + 14} y2={p.y + 16} stroke="#111827" strokeWidth={2.5} />
                <line x1={p.x - 9} y1={p.y + 22} x2={p.x + 9} y2={p.y + 22} stroke="#111827" strokeWidth={2.5} />
                <line x1={p.x - 4} y1={p.y + 28} x2={p.x + 4} y2={p.y + 28} stroke="#111827" strokeWidth={2.5} />
              </g>
            ) : (
              <circle
                cx={p.x}
                cy={p.y}
                r={selected ? 8 : 6}
                className={hasError ? "node-dot error" : "node-dot"}
              />
            )}
            <text x={p.x + 10} y={p.y - 10} className="node-label">
              {node.name || node.id}
              {op ? `  ${op.node_voltages[node.id]?.toFixed(4)} V` : ""}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

interface GlyphProps {
  c: ComponentDesc;
  selected: boolean;
  hasError: boolean;
  hasWarning: boolean;
  current?: number;
  onPointerDownBody: (e: React.PointerEvent<SVGElement>) => void;
  onPointerDownTerminal: (e: React.PointerEvent<SVGElement>, terminal: 0 | 1) => void;
}

function ComponentGlyph({ c, selected, hasError, hasWarning, current, onPointerDownBody, onPointerDownTerminal }: GlyphProps) {
  const p = c.position ?? { x: 0, y: 0 };
  const vertical = c.orientation === "vertical";
  const color = TYPE_COLOR[c.type];
  const stroke = hasError ? "#dc2626" : hasWarning ? "#d97706" : color;
  const currentText =
    current !== undefined && Math.abs(current) > 1e-15
      ? `${current >= 0 ? "→" : "←"} ${formatCurrent(Math.abs(current))}`
      : "";

  return (
    <g
      className={selected ? "component selected" : "component"}
      onPointerDown={onPointerDownBody}
    >
      {/* terminal handles (the only electrical drag targets) */}
      {[0, 1].map((t) => {
        const tp = terminalPoint(c, t as 0 | 1);
        return (
          <rect
            key={t}
            x={tp.x - 8}
            y={tp.y - 8}
            width={16}
            height={16}
            rx={3}
            className="terminal-handle"
            onPointerDown={(e) => onPointerDownTerminal(e, t as 0 | 1)}
          />
        );
      })}
      <SymbolShape c={c} p={p} vertical={vertical} stroke={stroke} selected={selected} />
      <text x={p.x} y={p.y + (vertical ? -40 : 44)} textAnchor="middle" className="comp-id">
        {c.name || c.id}
      </text>
      <text x={p.x} y={p.y + (vertical ? 44 : 60)} textAnchor="middle" className="comp-value">
        {paramSummary(c)}
      </text>
      {currentText && (
        <text x={p.x} y={p.y + (vertical ? 58 : 76)} textAnchor="middle" className="comp-current">
          {currentText}
        </text>
      )}
    </g>
  );
}

function SymbolShape({ c, p, vertical, stroke, selected }: {
  c: ComponentDesc; p: Position; vertical: boolean; stroke: string; selected: boolean;
}) {
  const w = SYM.w / 2;
  const sw = selected ? 3.5 : 2.5;
  const common = { fill: "none", stroke, strokeWidth: sw, strokeLinejoin: "round" as const };

  let shape: React.ReactNode = null;
  if (c.type === "resistor") {
    const d = `M${-w - LEAD},0 L${-w},0 l6,-10 l12,20 l12,-20 l12,20 l12,-20 l6,10 L${w + LEAD},0`;
    shape = <path d={d} {...common} />;
  } else if (c.type === "capacitor") {
    shape = (
      <g {...common}>
        <path d={`M${-w - LEAD},0 L-6,0 M6,0 L${w + LEAD},0`} />
        <line x1={-6} y1={-14} x2={-6} y2={14} />
        <line x1={6} y1={-14} x2={6} y2={14} />
      </g>
    );
  } else if (c.type === "diode") {
    shape = (
      <g {...common}>
        <path d={`M${-w - LEAD},0 L-10,0 M10,0 L${w + LEAD},0`} />
        <polygon points="-10,-12 -10,12 10,0" fill={stroke} />
        <line x1={10} y1={-12} x2={10} y2={12} />
      </g>
    );
  } else {
    shape = (
      <g {...common}>
        <path d={`M${-w - LEAD},0 L-18,0 M18,0 L${w + LEAD},0`} />
        <circle cx={0} cy={0} r={18} />
        <text x={0} y={5} textAnchor="middle" fontSize={16} fill={stroke} stroke="none">
          +−
        </text>
      </g>
    );
  }

  return (
    <g transform={`translate(${p.x},${p.y}) ${vertical ? "rotate(90)" : ""}`}>
      {shape}
    </g>
  );
}

function paramSummary(c: ComponentDesc): string {
  switch (c.type) {
    case "resistor":
      return formatEng(c.params.resistance, "Ω");
    case "capacitor":
      return formatEng(c.params.capacitance, "F");
    case "voltage_source":
      return `${c.params.dc} V${c.params.ac_mag ? ` · AC ${c.params.ac_mag} V` : ""}`;
    case "diode":
      return `Is=${formatEng(c.params.saturation_current, "A")}  Vt=${c.params.thermal_voltage} V`;
  }
}

export function formatEng(v: number, unit: string): string {
  if (v === 0) return `0 ${unit}`;
  const exp = Math.floor(Math.log10(Math.abs(v)) / 3) * 3;
  const scales: Record<number, string> = {
    "-12": "p", "-9": "n", "-6": "µ", "-3": "m", 0: "", 3: "k", 6: "M", 9: "G",
  };
  const s = scales[exp] ?? `e${exp}`;
  return `${+(v / 10 ** exp).toFixed(6)} ${s}${unit}`;
}

function formatCurrent(a: number): string {
  return formatEng(a, "A");
}
