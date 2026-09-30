import { useRef } from "react";
import { useStore } from "../store";
import { compile } from "../compiler";
import { isApiNetlist, isDocument, netlistToDocument } from "../importer";

function download(name: string, text: string) {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function TopBar() {
  const fileRef = useRef<HTMLInputElement>(null);
  const doc = useStore((s) => s.doc);
  const setDoc = useStore((s) => s.setDoc);
  const status = useStore((s) => s.status);
  const currentHash = useStore((s) => s.currentHash);
  const resultHash = useStore((s) => s.resultHash);

  const pill = (() => {
    if (status === "running")
      return <span className="status-pill running"><span className="dot" />求解中</span>;
    if (status === "error")
      return <span className="status-pill error"><span className="dot" />当前电路失败</span>;
    if (status === "ok" && resultHash === currentHash)
      return <span className="status-pill ok"><span className="dot" />结果与电路一致</span>;
    if (status === "idle")
      return <span className="status-pill stale"><span className="dot" />等待求解</span>;
    return <span className="status-pill stale"><span className="dot" />结果已过期</span>;
  })();

  const onFile = async (file: File) => {
    try {
      const obj = JSON.parse(await file.text());
      if (isDocument(obj)) {
        setDoc(obj);
      } else if (isApiNetlist(obj)) {
        setDoc(netlistToDocument(obj));
      } else {
        alert("无法识别的电路描述文件");
      }
    } catch (e) {
      alert(`导入失败：${e instanceof Error ? e.message : "JSON 解析错误"}`);
    }
  };

  return (
    <div className="topbar">
      <h1>Circuit Bias Workbench</h1>
      {pill}
      <span className="muted">电气输入 {currentHash?.slice(0, 10) ?? "—"}</span>
      <div className="spacer" />
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void onFile(f);
          e.target.value = "";
        }}
      />
      <button onClick={() => fileRef.current?.click()}>导入电路</button>
      <button
        title="导出完整工作台文档（含图形布局，可再次导入编辑）"
        onClick={() => download("circuit-workbench.json", JSON.stringify(doc, null, 2))}
      >
        导出工程
      </button>
      <button
        title="导出纯电气网表（不含任何坐标，可用后端接口独立复算）"
        onClick={() =>
          download("circuit-netlist.json", JSON.stringify(compile(doc).api, null, 2))}
      >
        导出网表
      </button>
    </div>
  );
}
