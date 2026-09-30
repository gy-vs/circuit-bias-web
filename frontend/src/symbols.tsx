import type { DeviceInstance } from "./types";

export interface LocalPin {
  id: string;
  x: number;
  y: number;
}

/** Pin offsets in the *unrotated* local frame (half-stub length 50). */
export function localPins(type: DeviceInstance["type"]): LocalPin[] {
  if (type === "resistor" || type === "capacitor") {
    // Horizontal part: n1 on the left, n2 on the right.
    return [
      { id: "n1", x: -50, y: 0 },
      { id: "n2", x: 50, y: 0 },
    ];
  }
  // Vertical part (voltage source, diode): n1 on top, n2 on bottom.
  return [
    { id: "n1", x: 0, y: -50 },
    { id: "n2", x: 0, y: 50 },
  ];
}

export function pinWorldPosition(dev: DeviceInstance, pinId: string): { x: number; y: number } {
  const pin = localPins(dev.type).find((p) => p.id === pinId);
  if (!pin) throw new Error(`bad pin ${pinId} on ${dev.id}`);
  const rad = (dev.rotation * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return {
    x: dev.x + pin.x * c - pin.y * s,
    y: dev.y + pin.x * s + pin.y * c,
  };
}

/** SVG geometry drawn in the local frame; the caller applies translate+rotate. */
export function SymbolShape({ type }: { type: DeviceInstance["type"] }) {
  const lead = "var(--wire)";
  const sw = 2.5;
  if (type === "resistor") {
    const pts = [
      [-40, 0], [-32, -10], [-20, 10], [-8, -10],
      [4, 10], [16, -10], [28, 10], [36, 0],
    ].map(([x, y]) => `${x},${y}`).join(" ");
    return (
      <g>
        <line x1={-50} y1={0} x2={-40} y2={0} stroke={lead} strokeWidth={sw} />
        <polyline points={pts} fill="none" stroke={lead} strokeWidth={sw} strokeLinejoin="round" />
        <line x1={36} y1={0} x2={50} y2={0} stroke={lead} strokeWidth={sw} />
      </g>
    );
  }
  if (type === "capacitor") {
    return (
      <g>
        <line x1={-50} y1={0} x2={-7} y2={0} stroke={lead} strokeWidth={sw} />
        <line x1={-7} y1={-16} x2={-7} y2={16} stroke={lead} strokeWidth={sw} />
        <line x1={7} y1={-16} x2={7} y2={16} stroke={lead} strokeWidth={sw} />
        <line x1={7} y1={0} x2={50} y2={0} stroke={lead} strokeWidth={sw} />
      </g>
    );
  }
  if (type === "voltage_source") {
    return (
      <g>
        <line x1={0} y1={-50} x2={0} y2={-22} stroke={lead} strokeWidth={sw} />
        <line x1={0} y1={22} x2={0} y2={50} stroke={lead} strokeWidth={sw} />
        <circle r={22} fill="var(--panel)" stroke={lead} strokeWidth={sw} />
        <text x={0} y={-8} textAnchor="middle" fontSize={16} fontWeight={700} fill={lead}>+</text>
        <text x={0} y={13} textAnchor="middle" fontSize={16} fontWeight={700} fill={lead}>−</text>
      </g>
    );
  }
  // diode: anode (n1) on top, triangle points toward the cathode bar
  return (
    <g>
      <line x1={0} y1={-50} x2={0} y2={-12} stroke={lead} strokeWidth={sw} />
      <polygon points="-11,-12 11,-12 0,13" fill="var(--panel)" stroke={lead} strokeWidth={sw} strokeLinejoin="round" />
      <line x1={-13} y1={15} x2={13} y2={15} stroke={lead} strokeWidth={sw} />
      <line x1={0} y1={15} x2={0} y2={50} stroke={lead} strokeWidth={sw} />
    </g>
  );
}
