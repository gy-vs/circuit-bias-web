// Circuit description types shared with the backend (backend/app/models.py).

export type ComponentType = "resistor" | "capacitor" | "voltage_source" | "diode";
export type Orientation = "horizontal" | "vertical";

export interface Position {
  x: number;
  y: number;
}

export interface NodeDesc {
  id: string;
  name?: string;
  // graphical only; never participates in the electrical fingerprint
  position?: Position;
}

export interface ComponentDesc {
  id: string;
  type: ComponentType;
  name?: string;
  nodes: [string, string]; // terminal 0 -> terminal 1 (diode: anode -> cathode)
  params: Record<string, number>;
  // graphical only
  position?: Position;
  orientation?: Orientation;
}

export interface ProbeDesc {
  id: string;
  name?: string;
  plus: string;
  minus: string;
}

export interface Circuit {
  format?: string;
  ground: string;
  nodes: NodeDesc[];
  components: ComponentDesc[];
  probes: ProbeDesc[];
}

export interface Diagnostic {
  code: string;
  message: string;
  severity: "error" | "warning";
  nodes?: string[];
  components?: string[];
  probes?: string[];
}

export interface DiodeInfo {
  conductance: number;
  dynamic_resistance: number;
  voltage: number;
}

export interface OperatingPoint {
  node_voltages: Record<string, number>;
  component_currents: Record<string, number>;
  components: Record<string, DiodeInfo>;
}

export interface ProbeSeries {
  name: string;
  plus: string;
  minus: string;
  gain_db: number[];
  phase_deg: number[];
}

export interface FrequencyResponse {
  input_source: string;
  freqs: number[];
  probes: Record<string, ProbeSeries>;
}

export interface SolveResult {
  ok: boolean;
  ac_ok: boolean;
  hash: string | null;
  diagnostics: Diagnostic[];
  warnings: Diagnostic[];
  operating_point: OperatingPoint | null;
  frequency_response: FrequencyResponse | null;
}

export interface SweepSpec {
  type: "log" | "linear" | "list";
  start?: number;
  stop?: number;
  num?: number;
  points?: number[];
}

// Parameter metadata used by the editor and by new-component creation.
export const PARAM_META: Record<
  ComponentType,
  { key: string; label: string; unit: string; default: number }[]
> = {
  resistor: [{ key: "resistance", label: "电阻", unit: "Ω", default: 1000 }],
  capacitor: [{ key: "capacitance", label: "电容", unit: "F", default: 1e-6 }],
  voltage_source: [
    { key: "dc", label: "直流电压", unit: "V", default: 1 },
    { key: "ac_mag", label: "交流幅度", unit: "V", default: 1 },
    { key: "ac_phase", label: "交流相位", unit: "°", default: 0 },
  ],
  diode: [
    { key: "saturation_current", label: "反向饱和电流", unit: "A", default: 1e-12 },
    { key: "thermal_voltage", label: "热电压", unit: "V", default: 0.02585 },
  ],
};

export const TYPE_LABEL: Record<ComponentType, string> = {
  resistor: "电阻",
  capacitor: "电容",
  voltage_source: "电压源",
  diode: "二极管",
};
