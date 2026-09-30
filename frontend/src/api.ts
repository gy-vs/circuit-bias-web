import type { Circuit, SolveResult, SweepSpec } from "./types";

export async function fetchDefaultCircuit(): Promise<Circuit> {
  const r = await fetch("/api/default-circuit");
  if (!r.ok) throw new Error(`无法取得默认电路: ${r.status}`);
  return r.json();
}

export async function solveCircuit(
  circuit: Circuit,
  sweep: SweepSpec,
  inputSource: string | null,
): Promise<SolveResult> {
  const r = await fetch("/api/solve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ circuit, sweep, input_source: inputSource }),
  });
  if (!r.ok) {
    // Still a structured body on 400 (bad JSON)
    return r.json().catch(() => ({
      ok: false,
      ac_ok: false,
      hash: null,
      diagnostics: [{ code: "HTTP", message: `服务器错误 ${r.status}`, severity: "error" as const }],
      warnings: [],
      operating_point: null,
      frequency_response: null,
    }));
  }
  return r.json();
}
