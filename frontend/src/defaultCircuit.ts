import type { CircuitDocument } from "./types";

/**
 * Default document: 1 V source, 1 kOhm resistor, grounded diode with
 * 1 uF shunt.  This is the exact reference circuit -- the first screen
 * already shows an operable circuit with a probe, no intro page.
 *
 * Pin "n1" is the top terminal (anode / "+"), "n2" the bottom terminal.
 */
export function createDefaultDocument(): CircuitDocument {
  return {
    version: 1,
    groundJunction: "gnd",
    junctions: [
      { id: "gnd", x: 360, y: 380, name: "GND" },
      { id: "n1", x: 360, y: 120, name: "n1" },
      { id: "n2", x: 560, y: 120, name: "n2" },
    ],
    devices: [
      {
        id: "V1", type: "voltage_source", name: "V1",
        x: 360, y: 250, rotation: 0,
        dc: 1, ac: 1,
      },
      {
        id: "R1", type: "resistor", name: "R1",
        x: 460, y: 120, rotation: 0,
        r: 1000,
      },
      {
        id: "D1", type: "diode", name: "D1",
        x: 560, y: 250, rotation: 0,
        isat: 1e-12, vt: 0.02585,
      },
      {
        id: "C1", type: "capacitor", name: "C1",
        x: 700, y: 250, rotation: 0,
        c: 1e-6,
      },
    ],
    wires: [
      { id: "wV_top", a: { kind: "pin", device: "V1", pin: "n1" }, b: { kind: "junction", junction: "n1" }, via: [] },
      { id: "wV_bot", a: { kind: "pin", device: "V1", pin: "n2" }, b: { kind: "junction", junction: "gnd" }, via: [] },
      { id: "wR_left", a: { kind: "pin", device: "R1", pin: "n1" }, b: { kind: "junction", junction: "n1" }, via: [] },
      { id: "wR_right", a: { kind: "pin", device: "R1", pin: "n2" }, b: { kind: "junction", junction: "n2" }, via: [] },
      { id: "wD_top", a: { kind: "pin", device: "D1", pin: "n1" }, b: { kind: "junction", junction: "n2" }, via: [] },
      { id: "wD_bot", a: { kind: "pin", device: "D1", pin: "n2" }, b: { kind: "junction", junction: "gnd" }, via: [] },
      { id: "wC_top", a: { kind: "pin", device: "C1", pin: "n1" }, b: { kind: "junction", junction: "n2" }, via: [] },
      { id: "wC_bot", a: { kind: "pin", device: "C1", pin: "n2" }, b: { kind: "junction", junction: "gnd" }, via: [] },
    ],
    probes: [
      {
        id: "P1", name: "V(n2)",
        plus: { kind: "junction", junction: "n2" },
        minus: { kind: "junction", junction: "gnd" },
      },
    ],
    inputSource: "V1",
    sweep: { type: "log", start: 1, stop: 1e6, points_per_decade: 40, extra: [10] },
  };
}
