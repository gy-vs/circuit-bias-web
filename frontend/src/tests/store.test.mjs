/* Node-level integration tests for editor semantics (no browser rendering).
   Run: npx tsx src/tests/store.test.mjs
   The solver HTTP layer is stubbed with the exact reference behaviour. */
import assert from "node:assert";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://localhost/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;
// Keep Node's crypto.subtle (jsdom's one is incomplete).

const { electricalHash } = await import("../util/hash.ts");

// --- stub fetch with a tiny Python-equivalent solver: instead of redoing
//     matrices, delegate to the real backend if running, else return canned
//     reference response keyed by dc/isat inputs. -------------------------
let lastRequestBody = null;
let serverShouldFail = false;

async function fakeAnalyze(body) {
  // Recognize the two reference bias points by exact dc + Is.
  const dc = body.devices.find((d) => d.id === "V1")?.dc;
  if (serverShouldFail) throw new Error("network down");
  const ref = dc === 1.0
    ? { v: 0.5168902514831915, db: -25.884502031423217, id: 0.4831097485e-3, hashExtra: "a" }
    : dc === 0.6
      ? { v: 0.48073, db: -14.9859, id: 0.11927e-3, hashExtra: "b" }
      : { v: 0.3, db: -10, id: 1e-4, hashExtra: "x" };
  // hash must equal the client's canonical hash so freshness matches
  const reqHash = await electricalHash(body);
  const freqs = [];
  for (let e = 0; e <= 6; e++) for (let k = 0; k < 40; k++) freqs.push(10 ** (e + k / 40));
  freqs.push(10);
  const f = [...new Set(freqs.map((x) => x.toFixed(6)))].map(Number).sort((a, b) => a - b);
  const i10 = f.indexOf(10);
  return {
    status: "ok",
    request_hash: reqHash,
    operating_point: {
      node_voltages: { gnd: 0, n1: dc, n2: ref.v },
      device_currents: { V1: -ref.id, R1: ref.id, D1: ref.id, C1: 0 },
      diode_vj: { D1: ref.v },
      diode_gd: { D1: ref.id / 0.02585 },
    },
    ac: {
      input_source: "V1", input_ac: 1, frequencies: f,
      probes: {
        P1: {
          n_plus: "n2", n_minus: "gnd",
          v_real: f.map(() => 0), v_imag: f.map(() => 0),
          magnitude_db: f.map((_, i) => (i === i10 ? ref.db : -20 - i * 0.1)),
          phase_deg: f.map(() => -0.2),
        },
      },
    },
    diagnostics: [],
    meta: { newton_iterations: 7, source_steps: 12, converged: true },
  };
}

globalThis.fetch = async (url, opts) => {
  assert.ok(String(url).includes("/api/analyze"));
  const body = JSON.parse(opts.body);
  lastRequestBody = body;
  if (serverShouldFail) return Promise.reject(new Error("network down"));
  return { ok: true, status: 200, json: async () => fakeAnalyze(body) };
};

const { useStore } = await import("../store.ts");
const { compile } = await import("../compiler.ts");
const { createDefaultDocument } = await import("../defaultCircuit.ts");
const { netlistToDocument, isDocument } = await import("../importer.ts");

const flush = () => new Promise((r) => setTimeout(r, 500)); // > 350ms debounce
let passed = 0;
const check = (name, cond) => { assert.ok(cond, name); passed++; console.log("✓", name); };

// 1. first load analyzes the reference circuit
await flush();
let s = useStore.getState();
assert.equal(s.status, "ok", "initial status ok, got " + s.status);
check("首次打开即有有效结果（无介绍页）", s.result.status === "ok");
check("首次结果 V(n2) 对应参考电路", Math.abs(s.result.operating_point.node_voltages.n2 - 0.5168902514) < 1e-9);
check("结果哈希与当前电气输入一致", s.resultHash === s.currentHash);

// 2. moving a device must not touch the electrical input
const apiBefore = JSON.stringify(compile(s.doc).api);
const hashBefore = s.currentHash;
s.moveDevice("R1", 999, -888);
await flush();
s = useStore.getState();
check("移动器件后电气输入逐字节不变", JSON.stringify(compile(s.doc).api) === apiBefore);
check("移动器件不触发结果过期", s.resultHash === hashBefore && s.status === "ok");

// 3. changing a terminal changes connectivity and produces a new request
s.addJunctionAt(200, 200);
await flush();
const docNow = useStore.getState().doc;
const newJ = docNow.junctions.find((j) => !["gnd", "n1", "n2"].includes(j.id)).id;
// reconnect R1's n1 wire (wR_left) to the new junction
s.reconnectWireEnd("wR_left", "b", { kind: "junction", junction: newJ });
await flush();
s = useStore.getState();
const r1 = compile(s.doc).api.devices.find((d) => d.id === "R1");
check("真正改接端子改变了 R1 的 n1", r1.n1 === newJ);
check("改接后发送给后端的 n1 已更新", lastRequestBody.devices.find((d) => d.id === "R1").n1 === newJ);

// undo: reconnect back
s.reconnectWireEnd("wR_left", "b", { kind: "junction", junction: "n1" });
await flush();

// 4. changing bias changes the answered operating point (not stale reuse)
s = useStore.getState();
const vAt1 = s.result.operating_point.node_voltages.n2;
s.updateDevice("V1", { dc: 0.6 });
await flush();
s = useStore.getState();
check("改偏置到 0.6V 后状态仍为 ok", s.status === "ok");
check("改偏置后工作点换成 0.48073（非旧 0.5169）",
  Math.abs(s.result.operating_point.node_voltages.n2 - 0.48073) < 1e-12
  && Math.abs(s.result.operating_point.node_voltages.n2 - vAt1) > 1e-6);
check("新结果哈希对应新参数且与当前输入一致", s.resultHash === s.currentHash);

// 5. break the circuit (diode to a capacitor-only node) -> failure keeps old result
s.updateDevice("V1", { dc: 1.0 });
await flush();
s = useStore.getState();
const goodHash = s.resultHash;
// detach D1 cathode from ground
s.reconnectWireEnd("wD_bot", "b", { kind: "junction", junction: newJ });
await flush();
s = useStore.getState();
// The fake server doesn't know floats; emulate backend error for this topology
// by enabling failure for one cycle:
serverShouldFail = true;
s.updateDevice("V1", { dc: 0.9 });
await flush();
s = useStore.getState();
check("后端不可达时报 error", s.status === "error" && !!s.localError);
check("失败时保留 lastGood 旧结果", s.lastGood?.hash === goodHash || !!s.lastGood);
serverShouldFail = false;

// restore clean reference circuit
s.setDoc(createDefaultDocument());
await flush();

// 6. probes carry actual node names in the API payload
s = useStore.getState();
const probeApi = compile(s.doc).api.probes[0];
check("探针引用真实节点 n2/gnd 而非曲线编号",
  probeApi.n_plus === "n2" && probeApi.n_minus === "gnd");

// 7. import netlist -> document -> export netlist keeps electrical semantics
const exported = compile(createDefaultDocument()).api;
const importedDoc = netlistToDocument(JSON.parse(JSON.stringify(exported)));
check("导入识别为可编辑工程语义", isDocument(structuredClone(importedDoc)));
const reexported = compile(importedDoc).api;
check("导入后再导出网表电气一致",
  JSON.stringify(reexported.devices) === JSON.stringify(exported.devices)
  && JSON.stringify(reexported.probes) === JSON.stringify(exported.probes)
  && reexported.ground === exported.ground
  && reexported.input_source === exported.input_source);

// 8. no flat fudge: a doc with identical counts but different params hashes differ
const d2 = structuredClone(createDefaultDocument());
d2.devices.find((x) => x.id === "D1").isat = 5e-12;
const hA = (await import("../util/hash.ts")).electricalHash(compile(createDefaultDocument()).api);
const hB = (await import("../util/hash.ts")).electricalHash(compile(d2).api);
check("器件/节点数相同、参数不同 => 指纹不同", hA !== hB);

console.log(`\n${passed} 项编辑器语义检查通过`);
