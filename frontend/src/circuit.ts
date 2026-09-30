// Pure circuit editing helpers. Electrical edits (terminals, params) and
// graphical edits (position, orientation) both go through here, but only the
// electrical ones change the hash the results are keyed by.
import type {
  Circuit,
  ComponentDesc,
  ComponentType,
  Orientation,
  Position,
  ProbeDesc,
} from "./types";
import { PARAM_META } from "./types";

let counter = 0;
export function uniqueId(prefix: string, existing: Set<string>): string {
  let n = 1;
  let candidate = `${prefix}${n}`;
  while (existing.has(candidate)) {
    n += 1;
    candidate = `${prefix}${n}`;
  }
  counter += 1;
  return candidate;
}

export function defaultParams(type: ComponentType): Record<string, number> {
  const params: Record<string, number> = {};
  for (const meta of PARAM_META[type]) params[meta.key] = meta.default;
  return params;
}

export function newComponent(type: ComponentType, existing: Set<string>): ComponentDesc {
  const prefix = {
    resistor: "R",
    capacitor: "C",
    voltage_source: "V",
    diode: "D",
  }[type];
  return {
    id: uniqueId(prefix, existing),
    type,
    nodes: ["", ""],
    params: defaultParams(type),
    position: { x: 120 + (counter % 5) * 40, y: 120 + (counter % 5) * 40 },
    orientation: "horizontal",
  };
}

export function addNode(circuit: Circuit, name?: string): string {
  const id = uniqueId("n", new Set(circuit.nodes.map((n) => n.id)));
  circuit.nodes.push({ id, name: name ?? id });
  return id;
}

export function newProbe(plus: string, minus: string, existing: Set<string>): ProbeDesc {
  return { id: uniqueId("P", existing), plus, minus };
}

export function removeComponent(circuit: Circuit, id: string): void {
  circuit.components = circuit.components.filter((c) => c.id !== id);
  // dangling terminals are a real edit result and will be diagnosed by the
  // backend, but probes referencing removed nodes are cleaned here
  const nodeIds = new Set(circuit.nodes.map((n) => n.id));
  circuit.probes = circuit.probes.filter((p) => nodeIds.has(p.plus) && nodeIds.has(p.minus));
}

export function removeNode(circuit: Circuit, id: string): void {
  if (id === circuit.ground) return;
  circuit.nodes = circuit.nodes.filter((n) => n.id !== id);
  for (const c of circuit.components) {
    c.nodes = c.nodes.map((ref) => (ref === id ? "" : ref)) as [string, string];
  }
  circuit.probes = circuit.probes.filter((p) => p.plus !== id && p.minus !== id);
}

export function setComponentPosition(
  c: ComponentDesc,
  pos: Position,
): void {
  c.position = pos;
}

export function setComponentOrientation(c: ComponentDesc, orientation: Orientation): void {
  c.orientation = orientation;
}

// ---------------------------------------------------------------------------
// Import normalization
// ---------------------------------------------------------------------------

export function normalizeImport(raw: unknown): Circuit {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("文件不是 JSON 对象");
  }
  const obj = raw as Record<string, unknown>;
  const nodes = Array.isArray(obj.nodes) ? (obj.nodes as unknown[]) : [];
  const components = Array.isArray(obj.components) ? (obj.components as unknown[]) : [];

  const normNodes = nodes.map((n, i) => {
    if (typeof n === "string") return { id: n, name: n };
    const o = n as Record<string, unknown>;
    const id = String(o.id ?? `n${i + 1}`);
    return {
      id,
      name: typeof o.name === "string" ? o.name : id,
      position: posOf(o.position),
    };
  });

  const normComponents = components.map((c0, i) => {
    const o = c0 as Record<string, unknown>;
    const type = String(o.type) as ComponentType;
    const termNodes = Array.isArray(o.nodes) ? (o.nodes as unknown[]).map(String) : ["", ""];
    const rawParams = (o.params ?? {}) as Record<string, unknown>;
    const params: Record<string, number> = {};
    for (const [k, v] of Object.entries(rawParams)) {
      const num = typeof v === "string" ? parseQuantity(v) : Number(v);
      if (Number.isFinite(num)) params[k] = num;
    }
    return {
      id: String(o.id ?? `C${i + 1}`),
      type,
      name: typeof o.name === "string" ? o.name : String(o.id ?? `C${i + 1}`),
      nodes: [termNodes[0] ?? "", termNodes[1] ?? ""] as [string, string],
      params,
      position: posOf(o.position),
      orientation: o.orientation === "vertical" ? "vertical" : "horizontal",
    } satisfies ComponentDesc;
  });

  const probes = (Array.isArray(obj.probes) ? (obj.probes as unknown[]) : []).map((p0, i) => {
    const o = p0 as Record<string, unknown>;
    return {
      id: String(o.id ?? `P${i + 1}`),
      name: typeof o.name === "string" ? o.name : String(o.id ?? `P${i + 1}`),
      plus: String(o.plus ?? ""),
      minus: String(o.minus ?? ""),
    } satisfies ProbeDesc;
  });

  const ground = typeof obj.ground === "string" ? obj.ground : "gnd";
  return {
    format: "circuit-bias-web/1",
    ground,
    nodes: normNodes,
    components: normComponents,
    probes,
  };
}

function posOf(v: unknown): Position | undefined {
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const x = Number(o.x);
    const y = Number(o.y);
    if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
  }
  return undefined;
}

// Accept simple suffixed quantities on import: 1k, 2.2nF, 10u, 1Meg ...
const UNIT_SCALE: [RegExp, number][] = [
  [/^t(?:ohm|f)?$/i, 1e12],
  [/^g(?:ohm|f)?$/i, 1e9],
  [/^meg?(?:ohm|f)?$/i, 1e6],
  [/^m(?:ohm|f)?$/i, 1e-3],
  [/^u(?:f|ohm)?$/i, 1e-6],
  [/^micro/i, 1e-6],
  [/^n(?:f|ohm)?$/i, 1e-9],
  [/^p(?:f|ohm)?$/i, 1e-12],
  [/^k(?:ohm|f)?$/i, 1e3],
];

export function parseQuantity(text: string): number {
  const m = text.trim().match(/^([+-]?[\d.]+(?:e[+-]?\d+)?)\s*([a-z]*)/i);
  if (!m) return Number.NaN;
  const value = Number(m[1]);
  const suffix = m[2];
  if (!suffix) return value;
  for (const [re, scale] of UNIT_SCALE) {
    if (re.test(suffix)) return value * scale;
  }
  // bare unit names like "ohm", "v", "f" carry no scale
  return value;
}

// Assign positions to anything that came in without graphical data so the
// first view of an imported netlist is still readable.
export function autoLayout(circuit: Circuit): void {
  const placed = new Set<string>();
  circuit.components.forEach((c, i) => {
    if (!c.position) {
      c.position = { x: 160 + (i % 3) * 200, y: 180 + Math.floor(i / 3) * 160 };
    }
    placed.add(c.id);
  });
  void placed;
}
