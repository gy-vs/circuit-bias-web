import type { ApiCircuit, AnalysisResult } from "./types";

export async function analyzeCircuit(api: ApiCircuit): Promise<AnalysisResult> {
  const resp = await fetch("/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(api),
  });
  if (!resp.ok) {
    throw new Error(`后端请求失败: HTTP ${resp.status}`);
  }
  return resp.json();
}
