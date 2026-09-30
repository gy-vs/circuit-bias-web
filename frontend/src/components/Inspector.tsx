import { useEffect, useState } from "react";
import type { Circuit, ComponentDesc, NodeDesc, ProbeDesc } from "../types";
import { PARAM_META, TYPE_LABEL } from "../types";
import { formatEng } from "./CircuitCanvas";
import { parseQuantity } from "../circuit";

interface InspectorProps {
  circuit: Circuit;
  selection:
    | { kind: "component"; id: string }
    | { kind: "node"; id: string }
    | { kind: "probe"; id: string }
    | null;
  onUpdateComponent: (id: string, patch: Partial<ComponentDesc>) => void;
  onUpdateParam: (id: string, key: string, value: number) => void;
  onSetTerminal: (id: string, terminal: 0 | 1, nodeId: string) => void;
  onRenameNode: (id: string, name: string) => void;
  onSetGround: (id: string) => void;
  onDeleteNode: (id: string) => void;
  onDeleteComponent: (id: string) => void;
  onRenameProbe: (id: string, name: string) => void;
  onDeleteProbe: (id: string) => void;
  onStartProbe: (nodeId: string) => void;
  pendingProbePlus: string | null;
  onCancelProbe: () => void;
  onSetProbeTerminal: (id: string, side: "plus" | "minus", nodeId: string) => void;
}

export function Inspector(props: InspectorProps) {
  const { selection, circuit } = props;
  if (!selection) {
    return (
      <div className="inspector empty">
        <p>未选择对象。</p>
        <ul>
          <li>拖动<b>器件本体</b>只移动图形，不改变任何连接。</li>
          <li>拖动端子小方块到节点圆点，或在下方端子选择器中改接，才会改变电气连接。</li>
          <li>双击节点圆点可新建电压探针（先选 + 端再选 − 端）。</li>
        </ul>
      </div>
    );
  }
  if (selection.kind === "component") {
    const c = circuit.components.find((x) => x.id === selection.id);
    if (!c) return null;
    return <ComponentInspector c={c} props={props} />;
  }
  if (selection.kind === "node") {
    const node = circuit.nodes.find((n) => n.id === selection.id);
    if (!node) return null;
    return <NodeInspector node={node} props={props} />;
  }
  const probe = circuit.probes.find((p) => p.id === selection.id);
  if (!probe) return null;
  return <ProbeInspector probe={probe} props={props} />;
}

function ComponentInspector({ c, props }: { c: ComponentDesc; props: InspectorProps }) {
  return (
    <div className="inspector">
      <div className="insp-header">
        <span className="badge">{TYPE_LABEL[c.type]}</span>
        <input
          className="name-input"
          value={c.name ?? c.id}
          onChange={(e) => props.onUpdateComponent(c.id, { name: e.target.value })}
        />
        <button className="btn danger small" onClick={() => props.onDeleteComponent(c.id)}>
          删除
        </button>
      </div>
      <div className="insp-id">id: {c.id}</div>

      <h4>端子连接（电气）</h4>
      {[0, 1].map((t) => (
        <div className="field-row" key={t}>
          <label>{t === 0 ? "端子 0" : "端子 1"}{c.type === "diode" ? (t === 0 ? "（阳极 A）" : "（阴极 K）") : ""}</label>
          <select
            value={c.nodes[t]}
            onChange={(e) => props.onSetTerminal(c.id, t as 0 | 1, e.target.value)}
          >
            <option value="">— 悬空（未接）—</option>
            {props.circuit.nodes.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name || n.id} ({n.id})
              </option>
            ))}
          </select>
        </div>
      ))}
      <div className="field-row">
        <label>朝向（仅图形）</label>
        <select
          value={c.orientation ?? "horizontal"}
          onChange={(e) =>
            props.onUpdateComponent(c.id, {
              orientation: e.target.value as "horizontal" | "vertical",
            })
          }
        >
          <option value="horizontal">水平</option>
          <option value="vertical">竖直</option>
        </select>
      </div>

      <h4>参数（电气）</h4>
      {PARAM_META[c.type].map((meta) => (
        <ParamField
          key={meta.key}
          label={meta.label}
          unit={meta.unit}
          value={c.params[meta.key] ?? meta.default}
          onCommit={(v) => props.onUpdateParam(c.id, meta.key, v)}
        />
      ))}
    </div>
  );
}

function ParamField({ label, unit, value, onCommit }: {
  label: string;
  unit: string;
  value: number;
  onCommit: (v: number) => void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const parsed = parseQuantity(text);
  const valid = Number.isFinite(parsed) && parsed > 0;
  return (
    <div className="field-row">
      <label title={label}>{label}</label>
      <span className="param-edit">
        <input
          className={valid ? "" : "invalid"}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => valid && onCommit(parsed)}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
        <em>{unit}</em>
        <small className="eng-hint">{formatEng(value, unit)}</small>
      </span>
    </div>
  );
}

function NodeInspector({ node, props }: { node: NodeDesc; props: InspectorProps }) {
  const isGround = node.id === props.circuit.ground;
  return (
    <div className="inspector">
      <div className="insp-header">
        <span className="badge node-badge">节点</span>
        <input
          className="name-input"
          value={node.name ?? node.id}
          onChange={(e) => props.onRenameNode(node.id, e.target.value)}
        />
        {!isGround && (
          <button className="btn danger small" onClick={() => props.onDeleteNode(node.id)}>
            删除
          </button>
        )}
      </div>
      <div className="insp-id">id: {node.id}</div>
      <div className="field-row">
        <label>参考点</label>
        {isGround ? (
          <strong className="ground-tag">⏚ 接地点（0 V）</strong>
        ) : (
          <button className="btn small" onClick={() => props.onSetGround(node.id)}>
            设为接地点
          </button>
        )}
      </div>
      <h4>电压探针</h4>
      {props.pendingProbePlus ? (
        <div className="probe-pending">
          {props.pendingProbePlus === node.id
            ? "此节点已选为探针 + 端，请双击另一个节点作为 − 端。"
            : `正在建探针：+ 端为 ${props.pendingProbePlus}。`}
          <button className="btn small" onClick={() => props.onStartProbe(node.id)}>
            改用此节点为 + 端
          </button>
          <button className="btn small ghost" onClick={props.onCancelProbe}>
            取消
          </button>
        </div>
      ) : (
        <button className="btn small" onClick={() => props.onStartProbe(node.id)}>
          以此节点为 + 端新建探针
        </button>
      )}
    </div>
  );
}

function ProbeInspector({ probe, props }: { probe: ProbeDesc; props: InspectorProps }) {
  const nameOf = (id: string) => props.circuit.nodes.find((n) => n.id === id)?.name ?? id;
  return (
    <div className="inspector">
      <div className="insp-header">
        <span className="badge probe-badge">电压探针</span>
        <input
          className="name-input"
          value={probe.name ?? probe.id}
          onChange={(e) => props.onRenameProbe(probe.id, e.target.value)}
        />
        <button className="btn danger small" onClick={() => props.onDeleteProbe(probe.id)}>
          删除
        </button>
      </div>
      <div className="insp-id">id: {probe.id}</div>
      <table className="probe-terms">
        <tbody>
          <tr>
            <td className="term-sign">+</td>
            <td>
              <select
                value={probe.plus}
                onChange={(e) => props.onSetProbeTerminal(probe.id, "plus", e.target.value)}
              >
                {props.circuit.nodes.map((n) => (
                  <option key={n.id} value={n.id}>{n.name || n.id}</option>
                ))}
              </select>
            </td>
          </tr>
          <tr>
            <td className="term-sign">−</td>
            <td>
              <select
                value={probe.minus}
                onChange={(e) => props.onSetProbeTerminal(probe.id, "minus", e.target.value)}
              >
                {props.circuit.nodes.map((n) => (
                  <option key={n.id} value={n.id}>{n.name || n.id}</option>
                ))}
              </select>
            </td>
          </tr>
        </tbody>
      </table>
      <p className="probe-explained">
        测量 V(<b>{nameOf(probe.plus)}</b>) − V(<b>{nameOf(probe.minus)}</b>)
      </p>
    </div>
  );
}
