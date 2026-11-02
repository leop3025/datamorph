"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Command, Search } from "lucide-react";
import { useActiveDataset, useStudio, type Tab } from "@/lib/store/studio";
import { STEP_DEFS } from "@/lib/pipeline/registry";
import { SAMPLES } from "@/lib/data/samples";
import { generateNotebook } from "@/lib/pipeline/codegen";
import { download } from "@/lib/data/export";

interface Cmd {
  id: string;
  label: string;
  group: string;
  run: () => void;
}

const TAB_NAMES: [Tab, string][] = [
  ["profile", "Profile"],
  ["data", "Data"],
  ["clean", "Clean"],
  ["transform", "Transform"],
  ["visualize", "Visualise"],
  ["analyze", "Analyse"],
  ["ml", "ML studio"],
  ["ai", "Ask AI"],
  ["sql", "Text to SQL"],
  ["dashboard", "Dashboard"],
];

/** Ctrl/Cmd+K: jump anywhere or run an action by name, e.g. "remove duplicates". */
export function CommandPalette({ onAddData }: { onAddData: () => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const store = useStudio();
  const active = useActiveDataset();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
        setQ("");
        setIndex(0);
      } else if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const commands = useMemo<Cmd[]>(() => {
    const cmds: Cmd[] = [];
    if (active) {
      cmds.push({ id: "dedupe", label: "Remove duplicate rows", group: "Clean", run: () => store.addStep("dropDuplicates", { columns: [] }) });
      for (const d of STEP_DEFS) cmds.push({ id: `tool-${d.type}`, label: d.label, group: d.group === "clean" ? "Clean" : "Transform", run: () => store.openTool(d.type, d.group) });
      for (const [tab, name] of TAB_NAMES) cmds.push({ id: `tab-${tab}`, label: `Go to ${name}`, group: "Navigate", run: () => store.setTab(tab) });
      cmds.push({ id: "undo", label: "Undo last step", group: "Recipe", run: () => store.undo() });
      cmds.push({ id: "redo", label: "Redo", group: "Recipe", run: () => store.redo() });
      cmds.push({ id: "nb", label: "Download Jupyter notebook", group: "Export", run: () => download(generateNotebook(active, store.datasets), `${active.table}_recipe.ipynb`, "application/x-ipynb+json") });
      cmds.push({ id: "report", label: "Open EDA report (print / PDF)", group: "Export", run: () => store.setReportOpen(true) });
    }
    cmds.push({ id: "add", label: "Add a dataset", group: "Data", run: onAddData });
    for (const s of SAMPLES) cmds.push({ id: `sample-${s.file}`, label: `Load sample: ${s.title}`, group: "Data", run: () => store.addUrl(`/samples/${s.file}`, s.file, true) });
    cmds.push({
      id: "theme",
      label: "Toggle dark mode",
      group: "View",
      run: () => {
        const dark = document.documentElement.getAttribute("data-theme") === "dark" || (!document.documentElement.hasAttribute("data-theme") && matchMedia("(prefers-color-scheme: dark)").matches);
        document.documentElement.setAttribute("data-theme", dark ? "light" : "dark");
        try {
          localStorage.setItem("theme", dark ? "light" : "dark");
        } catch {}
      },
    });
    return cmds;
  }, [active, store, onAddData]);

  const results = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return commands.filter((c) => words.every((w) => `${c.group} ${c.label}`.toLowerCase().includes(w))).slice(0, 12);
  }, [q, commands]);

  if (!open) return null;
  const run = (c?: Cmd) => {
    if (!c) return;
    setOpen(false);
    c.run();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[15vh]" onClick={() => setOpen(false)}>
      <div role="dialog" aria-label="Command palette" className="w-full max-w-lg overflow-hidden rounded-xl border bg-surface shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="h-4 w-4 text-muted" />
          <input
            ref={input}
            autoFocus
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setIndex(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") setIndex((i) => Math.min(i + 1, results.length - 1));
              else if (e.key === "ArrowUp") setIndex((i) => Math.max(i - 1, 0));
              else if (e.key === "Enter") run(results[index]);
            }}
            placeholder="Type a command, e.g. remove duplicates"
            className="w-full bg-transparent py-3 text-sm outline-none"
            aria-label="Command"
          />
        </div>
        <ul className="max-h-80 overflow-auto p-1">
          {results.length === 0 && <li className="px-3 py-4 text-sm text-muted">No matching command.</li>}
          {results.map((c, i) => (
            <li key={c.id}>
              <button
                onMouseEnter={() => setIndex(i)}
                onClick={() => run(c)}
                className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm ${i === index ? "bg-accent-soft text-accent" : ""}`}
              >
                {c.label}
                <span className="text-xs text-muted">{c.group}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="flex items-center gap-1 border-t px-3 py-2 text-xs text-muted">
          <Command className="h-3 w-3" /> K to toggle · ↑↓ to move · Enter to run
        </div>
      </div>
    </div>
  );
}
