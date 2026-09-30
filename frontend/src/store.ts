import { create } from "zustand";
import { analyzeCircuit } from "./api";
import { compile, type CompileIssue } from "./compiler";
import { createDefaultDocument } from "./defaultCircuit";
import type {
  AnalysisResult,
  CircuitDocument,
  DeviceInstance,
  DeviceType,
  EndpointRef,
  ProbeInstance,
} from "./types";
import { electricalHash } from "./util/hash";

export type Tool =
  | { kind: "select" }
  | { kind: "add"; device: DeviceType }
  | { kind: "wire" }
  | { kind: "probe" }
  | { kind: "junction" };

export type Selection =
  | { kind: "device"; id: string }
  | { kind: "junction"; id: string }
  | { kind: "wire"; id: string }
  | { kind: "probe"; id: string }
  | null;

interface AnalysisState {
  status: "idle" | "running" | "ok" | "error";
  result: AnalysisResult | null;
  /** hash of the electrical input that `result` was computed from */
  resultHash: string | null;
  /** hash of the document's current electrical content */
  currentHash: string | null;
  compileIssues: CompileIssue[];
  baseline: { result: AnalysisResult; hash: string } | null;
  /** last successful analysis, retained for comparison after an edit breaks it */
  lastGood: { result: AnalysisResult; hash: string } | null;
  /** error message when the backend itself cannot be reached */
  localError: string | null;
  /** frequency selected on the plot, fed back to canvas/inspector */
  markedFreq: number | null;
  markedProbe: string | null;
}

interface Store extends AnalysisState {
  doc: CircuitDocument;
  selection: Selection;
  tool: Tool;
  requestSeq: number;

  setDoc: (d: CircuitDocument) => void;
  setTool: (t: Tool) => void;
  select: (s: Selection) => void;

  // document mutations
  moveDevice: (id: string, x: number, y: number) => void;
  moveJunction: (id: string, x: number, y: number) => void;
  rotateDevice: (id: string) => void;
  updateDevice: (id: string, patch: Partial<DeviceInstance>) => void;
  renameJunction: (id: string, name: string) => void;
  setGround: (junctionId: string) => void;
  deleteSelection: () => void;
  addDeviceAt: (type: DeviceType, x: number, y: number) => string;
  addJunctionAt: (x: number, y: number) => string;
  addWire: (a: EndpointRef, b: EndpointRef) => void;
  reconnectWireEnd: (wireId: string, end: "a" | "b", to: EndpointRef) => void;
  deleteWire: (id: string) => void;
  addProbe: (plus: EndpointRef, minus: EndpointRef) => string;
  updateProbeEnd: (probeId: string, end: "plus" | "minus", to: EndpointRef) => void;
  renameProbe: (probeId: string, name: string) => void;
  deleteProbe: (id: string) => void;
  setInputSource: (deviceId: string | undefined) => void;
  updateSweep: (patch: Partial<CircuitDocument["sweep"]>) => void;

  keepBaseline: () => void;
  clearBaseline: () => void;
  markPlotPoint: (probeId: string | null, freq: number | null) => void;
  analyze: () => Promise<void>;
}

let idCounter = 1;
function uid(prefix: string): string {
  idCounter += 1;
  return `${prefix}${Date.now().toString(36)}${idCounter}`;
}

const DEFAULT_PARAMS: Record<DeviceType, Partial<DeviceInstance>> = {
  resistor: { r: 1000 },
  capacitor: { c: 1e-6 },
  voltage_source: { dc: 1, ac: 1 },
  diode: { isat: 1e-12, vt: 0.02585 },
};

async function computeHash(doc: CircuitDocument): Promise<string | null> {
  const { api } = compile(doc);
  return electricalHash(api);
}

export const useStore = create<Store>((set, get) => {
  // Debounced, abortable analysis scheduling.
  let timer: ReturnType<typeof setTimeout> | null = null;

  const scheduleAnalyze = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { void get().analyze(); }, 350);
  };

  const mutate = (fn: (d: CircuitDocument) => void) => {
    const next = structuredClone(get().doc) as CircuitDocument;
    fn(next);
    set({ doc: next });
    void computeHash(next).then((currentHash) => set({ currentHash }));
    scheduleAnalyze();
  };

  return {
    doc: createDefaultDocument(),
    selection: null,
    tool: { kind: "select" },
    requestSeq: 0,

    status: "idle",
    result: null,
    resultHash: null,
    currentHash: null,
    compileIssues: [],
    baseline: null,
    lastGood: null,
    localError: null,
    markedFreq: null,
    markedProbe: null,

    setDoc: (d) => {
      set({
        doc: d,
        selection: null,
        result: null,
        resultHash: null,
        baseline: null,
        lastGood: null,
        status: "idle",
        markedFreq: null,
        markedProbe: null,
      });
      void computeHash(d).then((currentHash) => set({ currentHash }));
      scheduleAnalyze();
    },

    setTool: (t) => set({ tool: t }),
    select: (s) => set({ selection: s }),

    moveDevice: (id, x, y) =>
      mutate((d) => {
        const dev = d.devices.find((x0) => x0.id === id);
        if (dev) { dev.x = x; dev.y = y; }
      }),

    moveJunction: (id, x, y) =>
      mutate((d) => {
        const j = d.junctions.find((j0) => j0.id === id);
        if (j) { j.x = x; j.y = y; }
      }),

    rotateDevice: (id) =>
      mutate((d) => {
        const dev = d.devices.find((x0) => x0.id === id);
        if (dev) dev.rotation = ((dev.rotation + 90) % 360) as 0 | 90 | 180 | 270;
      }),

    updateDevice: (id, patch) =>
      mutate((d) => {
        const dev = d.devices.find((x0) => x0.id === id);
        if (dev) Object.assign(dev, patch);
      }),

    renameJunction: (id, name) =>
      mutate((d) => {
        const j = d.junctions.find((j0) => j0.id === id);
        if (j) j.name = name;
      }),

    setGround: (junctionId) =>
      mutate((d) => { d.groundJunction = junctionId; }),

    deleteSelection: () => {
      const sel = get().selection;
      mutate((d) => {
        if (!sel) return;
        if (sel.kind === "device") {
          d.devices = d.devices.filter((x) => x.id !== sel.id);
          d.wires = d.wires.filter(
            (w) => !(w.a.kind === "pin" && w.a.device === sel.id)
              && !(w.b.kind === "pin" && w.b.device === sel.id));
          if (d.inputSource === sel.id) d.inputSource = undefined;
        } else if (sel.kind === "junction") {
          d.junctions = d.junctions.filter((x) => x.id !== sel.id);
          d.wires = d.wires.filter(
            (w) => !(w.a.kind === "junction" && w.a.junction === sel.id)
              && !(w.b.kind === "junction" && w.b.junction === sel.id));
          d.probes = d.probes.filter(
            (p) => !(p.plus.kind === "junction" && p.plus.junction === sel.id)
              && !(p.minus.kind === "junction" && p.minus.junction === sel.id));
        } else if (sel.kind === "wire") {
          d.wires = d.wires.filter((x) => x.id !== sel.id);
        } else if (sel.kind === "probe") {
          d.probes = d.probes.filter((x) => x.id !== sel.id);
        }
      });
      set({ selection: null });
    },

    addDeviceAt: (type, x, y) => {
      const id = uid(type[0].toUpperCase());
      mutate((d) => {
        d.devices.push({
          id, type, name: id, x, y, rotation: 0,
          ...DEFAULT_PARAMS[type],
        } as DeviceInstance);
      });
      return id;
    },

    addJunctionAt: (x, y) => {
      const id = uid("n");
      mutate((d) => {
        d.junctions.push({ id, x, y, name: id });
      });
      return id;
    },

    addWire: (a, b) => {
      if (JSON.stringify(a) === JSON.stringify(b)) return;
      mutate((d) => {
        d.wires.push({ id: uid("w"), a, b, via: [] });
      });
    },

    reconnectWireEnd: (wireId, end, to) =>
      mutate((d) => {
        const w = d.wires.find((x) => x.id === wireId);
        if (w) w[end] = to;
      }),

    deleteWire: (id) =>
      mutate((d) => { d.wires = d.wires.filter((x) => x.id !== id); }),

    addProbe: (plus, minus) => {
      const id = uid("P");
      mutate((d) => {
        const probe: ProbeInstance = {
          id, name: id, plus, minus,
        };
        d.probes.push(probe);
      });
      return id;
    },

    updateProbeEnd: (probeId, end, to) =>
      mutate((d) => {
        const p = d.probes.find((x) => x.id === probeId);
        if (p) p[end] = to;
      }),

    renameProbe: (probeId, name) =>
      mutate((d) => {
        const p = d.probes.find((x) => x.id === probeId);
        if (p) p.name = name;
      }),

    deleteProbe: (id) =>
      mutate((d) => { d.probes = d.probes.filter((x) => x.id !== id); }),

    setInputSource: (deviceId) =>
      mutate((d) => { d.inputSource = deviceId; }),

    updateSweep: (patch) =>
      mutate((d) => { Object.assign(d.sweep, patch); }),

    keepBaseline: () => {
      const { result, resultHash } = get();
      if (result?.status === "ok" && resultHash) {
        set({ baseline: { result, hash: resultHash } });
      }
    },
    clearBaseline: () => set({ baseline: null }),

    markPlotPoint: (probeId, freq) =>
      set({ markedProbe: probeId, markedFreq: freq }),

    analyze: async () => {
      const doc = get().doc;
      const compiled = compile(doc);
      const currentHash = await electricalHash(compiled.api);
      const seq = get().requestSeq + 1;
      set({ requestSeq: seq, status: "running", currentHash, compileIssues: compiled.issues, localError: null });

      try {
        const result = await analyzeCircuit(compiled.api);
        if (get().requestSeq !== seq) return; // a newer edit superseded us
        if (result.status === "ok") {
          set({
            status: "ok",
            result,
            resultHash: result.request_hash,
            lastGood: { result, hash: result.request_hash },
          });
        } else {
          // Keep the previous result visible, clearly marked as not current.
          set({ status: "error", result: null, resultHash: null });
        }
      } catch (e) {
        if (get().requestSeq !== seq) return;
        set({
          status: "error",
          result: null,
          resultHash: null,
          localError: e instanceof Error ? e.message : "后端不可达",
        });
      }
    },
  };
});

// kick off the first analysis as soon as the store exists
void useStore.getState().analyze();
