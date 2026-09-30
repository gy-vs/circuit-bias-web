import { useEffect } from "react";
import { Canvas } from "./components/Canvas";
import { Inspector } from "./components/Inspector";
import { ResultsPanel } from "./components/ResultsPanel";
import { TopBar } from "./components/TopBar";
import { Toolbar } from "./components/Toolbar";
import { useStore } from "./store";

export default function App() {
  const selection = useStore((s) => s.selection);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      const store = useStore.getState();
      if (e.key === "r" || e.key === "R") {
        if (selection?.kind === "device") store.rotateDevice(selection.id);
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (selection) store.deleteSelection();
      } else if (e.key === "v" || e.key === "V") {
        store.setTool({ kind: "select" });
      } else if (e.key === "w" || e.key === "W") {
        store.setTool({ kind: "wire" });
      } else if (e.key === "p" || e.key === "P") {
        store.setTool({ kind: "probe" });
      } else if (e.key === "n" || e.key === "N") {
        store.setTool({ kind: "junction" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selection]);

  return (
    <div className="app">
      <TopBar />
      <Toolbar />
      <Canvas />
      <div className="side">
        <Inspector />
        <ResultsPanel />
      </div>
    </div>
  );
}
