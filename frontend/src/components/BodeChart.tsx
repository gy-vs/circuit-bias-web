import { useMemo, useState } from "react";
import type { FrequencyResponse, OperatingPoint } from "../types";

interface BodeChartProps {
  response: FrequencyResponse;
  op: OperatingPoint;
  resultHash: string;
  activeProbeIds: string[];
  onPickFrequency: (info: FrequencyPick) => void;
  highlightedFreq: number | null;
}

export interface FrequencyPick {
  freq: number;
  probeId: string;
  gainDb: number;
  phaseDeg: number;
  plus: string;
  minus: string;
  hash: string;
}

const COLORS = ["#0d9488", "#7c3aed", "#2563eb", "#db2777", "#ea580c"];

export function BodeChart({
  response,
  op,
  resultHash,
  activeProbeIds,
  onPickFrequency,
  highlightedFreq,
}: BodeChartProps) {
  const freqs = response.freqs;
  const probeIds = Object.keys(response.probes).filter((id) => activeProbeIds.includes(id));

  const [hover, setHover] = useState<number | null>(null);
  const [width] = useState(680);
  const height = 240;
  const margin = { l: 56, r: 14, t: 16, b: 28 };

  const xScale = useMemo(() => {
    const lo = Math.log10(freqs[0]);
    const hi = Math.log10(freqs[freqs.length - 1]);
    return (f: number) =>
      margin.l + ((Math.log10(f) - lo) / (hi - lo || 1)) * (width - margin.l - margin.r);
  }, [freqs, width, margin.l, margin.r]);

  const yDomain = useMemo(() => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const id of probeIds) {
      for (const g of response.probes[id].gain_db) {
        if (Number.isFinite(g)) {
          lo = Math.min(lo, g);
          hi = Math.max(hi, g);
        }
      }
    }
    if (!Number.isFinite(lo)) return { lo: -10, hi: 10 };
    const pad = Math.max(3, (hi - lo) * 0.1);
    return { lo: lo - pad, hi: hi + pad };
  }, [probeIds, response.probes]);

  const yScale = (db: number) =>
    margin.t + ((yDomain.hi - db) / (yDomain.hi - yDomain.lo)) * (height - margin.t - margin.b);

  function pathFor(probeId: string, key: "gain_db" | "phase_deg", phase = false): string {
    const series = response.probes[probeId][key];
    const vals = freqs.map((f, i) => {
      const x = xScale(f);
      const y = phase ? phaseY(series[i]) : yScale(series[i]);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    });
    return vals.join(" ");
  }

  // phase gets its own normalized band drawn below gain, in lighter style
  const phaseHeight = 110;
  const phaseTop = height + 6;
  const phaseY = (deg: number) => {
    // wrap into -180..180 for display
    let d = deg % 360;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    const m2 = { t: phaseTop + 16, b: phaseTop + phaseHeight - 22 };
    return m2.t + ((180 - d) / 360) * (m2.b - m2.t);
  };

  function handleClick(e: React.MouseEvent<SVGSVGElement>) {
    if (!probeIds.length) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    // nearest frequency index
    let best = 0;
    let bestDist = Infinity;
    freqs.forEach((f, i) => {
      const d = Math.abs(xScale(f) - x);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    });
    // pick the closest probe curve to the click vertically as well
    const y = e.clientY - rect.top;
    let probeId = probeIds[0];
    let pd = Infinity;
    for (const id of probeIds) {
      const d = Math.abs(yScale(response.probes[id].gain_db[best]) - y);
      if (d < pd) {
        pd = d;
        probeId = id;
      }
    }
    const series = response.probes[probeId];
    onPickFrequency({
      freq: freqs[best],
      probeId,
      gainDb: series.gain_db[best],
      phaseDeg: series.phase_deg[best],
      plus: series.plus,
      minus: series.minus,
      hash: resultHash,
    });
  }

  const ticks = useMemo(() => {
    const lo = Math.floor(Math.log10(freqs[0]));
    const hi = Math.ceil(Math.log10(freqs[freqs.length - 1]));
    const out: number[] = [];
    for (let e = lo; e <= hi; e++) out.push(10 ** e);
    return out;
  }, [freqs]);

  void op; // operating point is shown by the parent alongside the pick card

  const totalH = phaseTop + phaseHeight + 8;

  return (
    <div className="bode">
      <svg
        width={width}
        height={totalH}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const x = e.clientX - rect.left;
          let best = 0;
          let bd = Infinity;
          freqs.forEach((f, i) => {
            const d = Math.abs(xScale(f) - x);
            if (d < bd) {
              bd = d;
              best = i;
            }
          });
          setHover(best);
        }}
        onMouseLeave={() => setHover(null)}
        onClick={handleClick}
      >
        {/* grid + gain axis */}
        {[0, 0.25, 0.5, 0.75, 1].map((t) => {
          const y = margin.t + t * (height - margin.t - margin.b);
          const val = yDomain.hi - t * (yDomain.hi - yDomain.lo);
          return (
            <g key={t}>
              <line x1={margin.l} y1={y} x2={width - margin.r} y2={y} stroke="#eef2f7" />
              <text x={margin.l - 6} y={y + 4} textAnchor="end" className="axis-text">
                {val.toFixed(0)}
              </text>
            </g>
          );
        })}
        <text x={14} y={margin.t + 12} className="axis-title">dB</text>

        {ticks.map((f) => (
          <g key={f}>
            <line
              x1={xScale(f)}
              y1={margin.t}
              x2={xScale(f)}
              y2={height - margin.b}
              stroke="#f1f5f9"
            />
            <text x={xScale(f)} y={height - 8} textAnchor="middle" className="axis-text">
              {f >= 1000 ? `${f / 1000}k` : f}
            </text>
          </g>
        ))}
        <text x={width - margin.r} y={height - margin.b + 22} textAnchor="end" className="axis-title">
          f (Hz)
        </text>

        {probeIds.map((id, k) => (
          <g key={id}>
            <path d={pathFor(id, "gain_db")} fill="none" stroke={COLORS[k % COLORS.length]} strokeWidth={2.2} />
            <path
              d={pathFor(id, "phase_deg", true)}
              fill="none"
              stroke={COLORS[k % COLORS.length]}
              strokeWidth={1.4}
              strokeDasharray="4 3"
              opacity={0.55}
            />
          </g>
        ))}

        {/* phase guide lines */}
        <line x1={margin.l} y1={phaseY(0)} x2={width - margin.r} y2={phaseY(0)} stroke="#cbd5e1" strokeDasharray="2 3" />
        <text x={margin.l - 6} y={phaseY(0) + 4} textAnchor="end" className="axis-text">0°</text>
        <text x={margin.l - 6} y={phaseY(-90) + 4} textAnchor="end" className="axis-text">−90°</text>
        <text x={margin.l - 6} y={phaseY(90) + 4} textAnchor="end" className="axis-text">+90°</text>
        <text x={14} y={phaseTop + 10} className="axis-title">相位</text>

        {/* hover / highlight marker */}
        {hover !== null && (
          <line
            x1={xScale(freqs[hover])}
            y1={margin.t}
            x2={xScale(freqs[hover])}
            y2={phaseTop + phaseHeight - 22}
            stroke="#94a3b8"
            strokeDasharray="3 3"
            pointerEvents="none"
          />
        )}
        {(highlightedFreq !== null
          ? freqs.findIndex((f) => Math.abs(f - highlightedFreq) < 1e-12)
          : -1) >= 0 && (
          <line
            x1={xScale(highlightedFreq!)}
            y1={margin.t}
            x2={xScale(highlightedFreq!)}
            y2={phaseTop + phaseHeight - 22}
            stroke="#0f766e"
            strokeWidth={2}
            pointerEvents="none"
          />
        )}
        {hover !== null && (
          <text x={xScale(freqs[hover])} y={margin.t + 2} textAnchor="middle" className="hover-label">
            {freqLabel(freqs[hover])} Hz · 点击选取
          </text>
        )}
      </svg>

      <div className="legend">
        {probeIds.map((id, k) => (
          <span key={id} className="legend-item">
            <i style={{ background: COLORS[k % COLORS.length] }} />
            {response.probes[id].name || id}
            <small>
              {" "}
              (+{response.probes[id].plus} / −{response.probes[id].minus})
            </small>
          </span>
        ))}
      </div>
    </div>
  );
}

function freqLabel(f: number): string {
  if (f >= 1000) return `${(f / 1000).toPrecision(4)}k`;
  return f.toPrecision(4);
}
