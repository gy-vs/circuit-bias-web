import type {
  ApiCircuit,
  ApiDevice,
  CircuitDocument,
  DeviceInstance,
  DeviceType,
  EndpointRef,
  Junction,
  ProbeInstance,
  Wire,
} from "./types";

function uid(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
}

export function isApiNetlist(obj: unknown): obj is ApiCircuit {
  if (typeof obj !== "object" || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return "ground" in o && Array.isArray(o.devices) &&
    (o.devices.length === 0 || typeof (o.devices[0] as Record<string, unknown>).n1 === "string");
}

export function isDocument(obj: unknown): obj is CircuitDocument {
  if (typeof obj !== "object" || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return "groundJunction" in o && Array.isArray(o.junctions) && Array.isArray(o.wires);
}

/**
 * Turn a purely electrical netlist into an editable, laid-out document.
 * Connectivity is reconstructed exactly (each device terminal gets a wire
 * to the junction that represents its electrical node); only coordinates
 * are invented.
 */
export function netlistToDocument(api: ApiCircuit): CircuitDocument {
  const nonGround = api.nodes.filter((n) => n.id !== api.ground);
  const positions = new Map<string, { x: number; y: number }>();
  positions.set(api.ground, { x: 0, y: 260 });
  nonGround.forEach((n, idx) => {
    const angle = -Math.PI / 2 + (idx * 2 * Math.PI) / Math.max(nonGround.length, 1);
    const radius = nonGround.length === 1 ? 0 : 230;
    positions.set(n.id, { x: radius * Math.cos(angle), y: radius * Math.sin(angle) - 30 });
  });

  const junctions: Junction[] = api.nodes.map((n) => ({
    id: n.id,
    x: positions.get(n.id)!.x,
    y: positions.get(n.id)!.y,
    ...(n.name ? { name: n.name } : {}),
  }));

  const devices: DeviceInstance[] = [];
  const wires: Wire[] = [];

  api.devices.forEach((d: ApiDevice, idx) => {
    const p1 = positions.get(d.n1) ?? { x: 0, y: 0 };
    const p2 = positions.get(d.n2) ?? { x: 0, y: 0 };
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const mid = {
      x: (p1.x + p2.x) / 2 + 30 * Math.sin(idx * 1.7),
      y: (p1.y + p2.y) / 2 + 30 * Math.cos(idx * 2.1),
    };
    // R/C are horizontal at rotation 0; sources/diodes are vertical.
    const horizontalType = d.type === "resistor" || d.type === "capacitor";
    let rotation: DeviceInstance["rotation"] = 0;
    if (horizontalType) {
      if (Math.abs(dy) > Math.abs(dx)) rotation = 90;
    } else {
      if (Math.abs(dx) > Math.abs(dy)) rotation = 90;
    }
    const dev: DeviceInstance = {
      id: d.id, type: d.type as DeviceType, name: d.name,
      x: mid.x, y: mid.y, rotation,
    };
    if (d.r !== undefined) dev.r = d.r;
    if (d.c !== undefined) dev.c = d.c;
    if (d.dc !== undefined) dev.dc = d.dc;
    if (d.ac !== undefined) dev.ac = d.ac;
    if (d.model) { dev.isat = d.model.is; dev.vt = d.model.vt; }
    devices.push(dev);

    (["n1", "n2"] as const).forEach((pin) => {
      const nodeId = pin === "n1" ? d.n1 : d.n2;
      if (positions.has(nodeId)) {
        wires.push({
          id: uid("w"),
          a: { kind: "pin", device: d.id, pin },
          b: { kind: "junction", junction: nodeId },
          via: [],
        });
      }
    });
  });

  const probes: ProbeInstance[] = api.probes
    .filter((p) => positions.has(p.n_plus) && positions.has(p.n_minus))
    .map((p) => ({
      id: p.id,
      ...(p.name ? { name: p.name } : {}),
      plus: { kind: "junction", junction: p.n_plus } as EndpointRef,
      minus: { kind: "junction", junction: p.n_minus } as EndpointRef,
    }));

  return {
    version: 1,
    groundJunction: api.ground,
    devices,
    junctions,
    wires,
    probes,
    ...(api.input_source ? { inputSource: api.input_source } : {}),
    sweep: api.sweep ?? { type: "log", start: 1, stop: 1e6, points_per_decade: 40, extra: [] },
  };
}
