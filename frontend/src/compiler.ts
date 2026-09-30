import type {
  ApiCircuit,
  ApiDevice,
  ApiProbe,
  CircuitDocument,
  EndpointRef,
} from "./types";

export interface CompileIssue {
  message: string;
  ref?: { type: "device" | "node" | "probe" | "source"; id: string };
}

export interface CompiledCircuit {
  api: ApiCircuit;
  /** maps electrical node id -> representative endpoint (junction id or pin) */
  nodeEndpoints: Map<string, EndpointRef[]>;
  /** each pin or junction -> electrical node id */
  endpointNode: Map<string, string>;
  issues: CompileIssue[];
}

const epKey = (e: EndpointRef): string =>
  e.kind === "junction" ? `j:${e.junction}` : `p:${e.device}.${e.pin}`;

/**
 * Union-find over all connectable endpoints using the explicit wires.
 * Layout coordinates are never inspected here: touching on the canvas
 * without a wire is NOT a connection.
 */
export function compile(doc: CircuitDocument): CompiledCircuit {
  const issues: CompileIssue[] = [];
  const parent = new Map<string, string>();

  const allEndpoints: EndpointRef[] = [];
  doc.junctions.forEach((j) => allEndpoints.push({ kind: "junction", junction: j.id }));
  doc.devices.forEach((d) => {
    (["n1", "n2"] as const).forEach((pin) =>
      allEndpoints.push({ kind: "pin", device: d.id, pin }));
  });
  allEndpoints.forEach((e) => parent.set(epKey(e), epKey(e)));

  const find = (a: string): string => {
    let r = a;
    while (parent.get(r) !== r) r = parent.get(r)!;
    while (parent.get(a) !== r) {
      const nxt = parent.get(a)!;
      parent.set(a, r);
      a = nxt;
    }
    return r;
  };
  const union = (a: string, b: string) => {
    parent.set(find(a), find(b));
  };

  doc.wires.forEach((w) => {
    if (!parent.has(epKey(w.a)) || !parent.has(epKey(w.b))) {
      issues.push({ message: "导线引用了不存在的端子或节点" });
      return;
    }
    union(epKey(w.a), epKey(w.b));
  });

  // Group endpoints by root.
  const groups = new Map<string, EndpointRef[]>();
  allEndpoints.forEach((e) => {
    const root = find(epKey(e));
    const arr = groups.get(root) ?? [];
    arr.push(e);
    groups.set(root, arr);
  });

  // Assign electrical node ids. A group containing the ground junction gets
  // the ground id; otherwise a junction name wins; else it's an isolated pin.
  const nodeOf = new Map<string, string>();
  const nodeEndpoints = new Map<string, EndpointRef[]>();
  const usedNames = new Set<string>();

  const uniqueId = (base: string): string => {
    let id = base;
    let k = 2;
    while (usedNames.has(id)) {
      id = `${base}_${k++}`;
    }
    usedNames.add(id);
    return id;
  };

  if (!doc.junctions.some((j) => j.id === doc.groundJunction)) {
    issues.push({
      message: `接地点 '${doc.groundJunction}' 不存在`,
      ref: { type: "node", id: doc.groundJunction },
    });
  }

  const groupList = Array.from(groups.values());
  const groundGroup = groupList.find((g) =>
    g.some((e) => e.kind === "junction" && e.junction === doc.groundJunction));
  if (groundGroup) {
    const gid = doc.groundJunction;
    usedNames.add(gid);
    nodeEndpoints.set(gid, groundGroup);
    groundGroup.forEach((e) => nodeOf.set(epKey(e), gid));
  }

  groupList.forEach((g) => {
    if (g === groundGroup) return;
    const junctions = g.filter((e) => e.kind === "junction") as Extract<EndpointRef, { kind: "junction" }>[];
    const pins = g.filter((e) => e.kind === "pin") as Extract<EndpointRef, { kind: "pin" }>[];

    let nodeId: string;
    if (junctions.length > 0) {
      // Junction id is the stable electrical id (round-trips netlists).
      nodeId = uniqueId(junctions[0].junction);
    } else {
      // pins shorted directly to each other without a junction
      nodeId = uniqueId(`pin_${pins[0].device}_${pins[0].pin}`);
    }
    nodeEndpoints.set(nodeId, g);
    g.forEach((e) => nodeOf.set(epKey(e), nodeId));

    if (junctions.length > 1) {
      issues.push({
        message: `节点 ${nodeId} 上有多个连接点（${junctions.map((j) => j.junction).join(", ")}）已合并`,
        ref: { type: "node", id: nodeId },
      });
    }
  });

  // Isolated (single-pin, un-wired) endpoints form a dangling electrical
  // node attached to exactly one pin -- the backend would reject it.
  nodeEndpoints.forEach((eps) => {
    const pinCount = eps.filter((e) => e.kind === "pin").length;
    const hasJunction = eps.some((e) => e.kind === "junction");
    if (!hasJunction && pinCount === 1) {
      const pin = eps.find((e) => e.kind === "pin") as Extract<EndpointRef, { kind: "pin" }>;
      issues.push({
        message: `器件 ${pin.device} 的端子 ${pin.pin} 悬空，未连接任何节点`,
        ref: { type: "device", id: pin.device },
      });
    }
  });

  const nodeIds = Array.from(nodeEndpoints.keys());
  const nodes = nodeIds.map((id) => {
    const j = doc.junctions.find((x) => x.id === id);
    return { id, ...(j?.name ? { name: j.name } : {}) };
  });

  const devices: ApiDevice[] = doc.devices.map((d) => {
    const n1 = nodeOf.get(epKey({ kind: "pin", device: d.id, pin: "n1" }))!;
    const n2 = nodeOf.get(epKey({ kind: "pin", device: d.id, pin: "n2" }))!;
    const out: ApiDevice = {
      id: d.id,
      type: d.type,
      ...(d.name ? { name: d.name } : {}),
      n1, n2,
    };
    if (d.type === "resistor") out.r = d.r;
    if (d.type === "capacitor") out.c = d.c;
    if (d.type === "voltage_source") {
      out.dc = d.dc;
      out.ac = d.ac;
    }
    if (d.type === "diode" && d.isat !== undefined && d.vt !== undefined) {
      out.model = { is: d.isat, vt: d.vt };
    }
    return out;
  });

  const probes: ApiProbe[] = [];
  doc.probes.forEach((p) => {
    const np = nodeOf.get(epKey(p.plus)) ?? "";
    const nm = nodeOf.get(epKey(p.minus)) ?? "";
    if (!np || !nm) {
      issues.push({
        message: `探针 ${p.id} 连接到了不存在或悬空的端点`,
        ref: { type: "probe", id: p.id },
      });
    }
    probes.push({
      id: p.id,
      ...(p.name ? { name: p.name } : {}),
      n_plus: np,
      n_minus: nm,
    });
  });

  return {
    api: {
      version: 1,
      ground: doc.groundJunction,
      nodes,
      devices,
      probes,
      ...(doc.inputSource ? { input_source: doc.inputSource } : {}),
      sweep: doc.sweep,
    },
    nodeEndpoints,
    endpointNode: nodeOf,
    issues,
  };
}
