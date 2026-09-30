/** Engineering-unit parsing/formatting used by the parameter editor. */

const PREFIXES: Record<string, number> = {
  f: 1e-15, p: 1e-12, n: 1e-9, u: 1e-6, µ: 1e-6,
  m: 1e-3, k: 1e3, K: 1e3, meg: 1e6, MEG: 1e6,
  g: 1e9, G: 1e9, t: 1e12,
};

export function parseValue(text: string): number | null {
  const t = text.trim().replace(/Ω|Ω|ohm|Ohm|V|F|A|Hz/g, "").trim();
  if (t === "") return null;
  // forms like "1k", "2.2n", "10MEG", "1e-6"
  const m = t.match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*([fpnuµmkKgt]|meg|MEG)?$/);
  if (!m) return null;
  const num = parseFloat(m[1]);
  if (!Number.isFinite(num)) return null;
  const mult = m[2] ? PREFIXES[m[2]] ?? 1 : 1;
  return num * mult;
}

const ENG_STEPS: ReadonlyArray<readonly [number, string]> = [
  [1e-15, "f"], [1e-12, "p"], [1e-9, "n"], [1e-6, "µ"],
  [1e-3, "m"], [1, ""], [1e3, "k"], [1e6, "M"], [1e9, "G"],
];

export function formatEng(v: number, digits = 4): string {
  if (v === 0) return "0";
  if (!Number.isFinite(v)) return String(v);
  const sign = v < 0 ? "-" : "";
  const a = Math.abs(v);
  let step = ENG_STEPS[0];
  for (const s of ENG_STEPS) if (a >= s[0]) step = s;
  const scaled = a / step[0];
  const str = scaled >= 100 ? scaled.toFixed(1) : scaled.toPrecision(digits - 1);
  return `${sign}${parseFloat(str)}${step[1]}`;
}

export function formatVolts(v: number): string {
  if (Math.abs(v) < 1e-9) return "0 V";
  return `${formatEng(v)} V`;
}

export function formatAmps(v: number): string {
  if (Math.abs(v) < 1e-15) return "0 A";
  return `${formatEng(v)} A`;
}

export function formatFreq(f: number): string {
  return `${formatEng(f)}Hz`;
}
