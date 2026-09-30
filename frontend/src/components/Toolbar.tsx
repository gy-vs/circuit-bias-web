import { useStore, type Tool } from "../store";

function IconBtn({ active, onClick, title, children }: {
  active: boolean; onClick: () => void; title: string; children: React.ReactNode;
}) {
  return (
    <div className={`tool ${active ? "active" : ""}`} title={title} onClick={onClick}>
      {children}
    </div>
  );
}

export function Toolbar() {
  const tool = useStore((s) => s.tool);
  const setTool = useStore((s) => s.setTool);
  const is = (t: Tool["kind"]) => tool.kind === t;

  return (
    <div className="toolbar">
      <IconBtn active={is("select")} onClick={() => setTool({ kind: "select" })} title="选择 / 拖动（V）">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M5 3l14 8-6 1.5L10 19z" strokeLinejoin="round" />
        </svg>
      </IconBtn>
      <IconBtn active={is("wire")} onClick={() => setTool({ kind: "wire" })} title="画导线（W）">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="4" cy="18" r="2.4" /><circle cx="20" cy="6" r="2.4" />
          <path d="M4 18V9h8V6h8" />
        </svg>
      </IconBtn>
      <IconBtn active={is("junction")} onClick={() => setTool({ kind: "junction" })} title="放置连接节点（N）">
        <svg viewBox="0 0 24 24" fill="currentColor">
          <circle cx="12" cy="12" r="4" />
        </svg>
      </IconBtn>
      <IconBtn active={is("probe")} onClick={() => setTool({ kind: "probe" })} title="放置电压探针（P）">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M4 20L14 4l6 10H8z" strokeLinejoin="round" />
        </svg>
      </IconBtn>
      <div style={{ width: 26, borderTop: "1px solid #2c3a49", margin: "4px 0" }} />
      <IconBtn active={tool.kind === "add" && tool.device === "resistor"}
        onClick={() => setTool({ kind: "add", device: "resistor" })} title="电阻（R）">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M1 12h4l2-5 3 10 3-10 3 10 2-5h5" />
        </svg>
      </IconBtn>
      <IconBtn active={tool.kind === "add" && tool.device === "capacitor"}
        onClick={() => setTool({ kind: "add", device: "capacitor" })} title="电容（C）">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M1 12h8M15 12h8" /><path d="M9 6v12M15 6v12" />
        </svg>
      </IconBtn>
      <IconBtn active={tool.kind === "add" && tool.device === "voltage_source"}
        onClick={() => setTool({ kind: "add", device: "voltage_source" })} title="独立电压源（S）">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <circle cx="12" cy="12" r="9" /><path d="M12 7v10M8 10l4-3 4 3M8 14l4 3 4-3" />
        </svg>
      </IconBtn>
      <IconBtn active={tool.kind === "add" && tool.device === "diode"}
        onClick={() => setTool({ kind: "add", device: "diode" })} title="二极管（D）">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M12 3v6M7 9l10 6V9zM12 15v6" strokeLinejoin="round" />
        </svg>
      </IconBtn>
    </div>
  );
}
