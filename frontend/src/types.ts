/**
 * Editor document model.
 *
 * Layout (coordinates, rotation, wire routes) and electrical semantics
 * (which pins/junctions share a node) live in one document, but only the
 * *compiled* electrical portion is ever sent to the solver.  Moving a
 * device changes coordinates only; the connectivity groups are keyed by
 * pin/junction ids, so results never change merely from dragging.
 */

export type DeviceType = "resistor" | "capacitor" | "voltage_source" | "diode";

export interface Pin {
  /** local pin id, e.g. "n1" / "n2" */
  id: string;
  dx: number;
  dy: number;
}

export interface DeviceInstance {
  id: string;
  type: DeviceType;
  name?: string;
  x: number;
  y: number;
  rotation: 0 | 90 | 180 | 270;
  // Electrical parameters in SI units (ohm, F, V, A).
  r?: number;
  c?: number;
  dc?: number;
  ac?: number;
  isat?: number;
  vt?: number;
}

/** A connectable point: either a device pin or a free junction. */
export type EndpointRef =
  | { kind: "pin"; device: string; pin: string }
  | { kind: "junction"; junction: string };

export interface Wire {
  id: string;
  a: EndpointRef;
  b: EndpointRef;
  /** intermediate route points in canvas coordinates (visual only) */
  via: { x: number; y: number }[];
}

export interface Junction {
  id: string;
  x: number;
  y: number;
  name?: string;
}

export interface ProbeInstance {
  id: string;
  name?: string;
  plus: EndpointRef;
  minus: EndpointRef;
}

export interface Sweep {
  type: "log" | "linear";
  start: number;
  stop: number;
  points_per_decade: number;
  extra: number[];
}

export interface CircuitDocument {
  version: number;
  groundJunction: string; // the junction id acting as reference ground
  devices: DeviceInstance[];
  junctions: Junction[];
  wires: Wire[];
  probes: ProbeInstance[];
  inputSource?: string;
  sweep: Sweep;
}

// ---- API wire format (electrical only) -----------------------------------

export interface ApiNode {
  id: string;
  name?: string;
}

export interface ApiDevice {
  id: string;
  type: DeviceType;
  name?: string;
  n1: string;
  n2: string;
  r?: number;
  c?: number;
  dc?: number;
  ac?: number;
  model?: { is: number; vt: number };
}

export interface ApiProbe {
  id: string;
  name?: string;
  n_plus: string;
  n_minus: string;
}

export interface ApiCircuit {
  version: number;
  ground: string;
  nodes: ApiNode[];
  devices: ApiDevice[];
  probes: ApiProbe[];
  input_source?: string;
  sweep: Sweep;
}

export interface Diagnostic {
  code: string;
  severity: "error" | "warning";
  message: string;
  ref_type: "device" | "node" | "probe" | "source" | null;
  ref_id: string | null;
}

export interface ProbeResponse {
  n_plus: string;
  n_minus: string;
  v_real: number[];
  v_imag: number[];
  magnitude_db: number[];
  phase_deg: number[];
}

export interface AnalysisResult {
  status: "ok" | "error";
  request_hash: string;
  operating_point: {
    node_voltages: Record<string, number>;
    device_currents: Record<string, number>;
    diode_vj: Record<string, number>;
    diode_gd: Record<string, number>;
  } | null;
  ac: {
    input_source: string;
    input_ac: number;
    frequencies: number[];
    probes: Record<string, ProbeResponse>;
  } | null;
  diagnostics: Diagnostic[];
  meta: { newton_iterations: number; source_steps: number; converged: boolean } | null;
}
