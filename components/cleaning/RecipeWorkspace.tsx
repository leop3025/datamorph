"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronRight, Code2, Table2 } from "lucide-react";
import type { Dataset } from "@/lib/data/types";
import { STEP_DEFS, getStepDef } from "@/lib/pipeline/registry";
import type { Step, StepDef } from "@/lib/pipeline/types";
import { useStudio } from "@/lib/store/studio";
import { DataTable } from "@/components/data-table/DataTable";
import { StepForm } from "./StepForm";
import { RecipePanel } from "./RecipePanel";
import { CodeDialog } from "./CodeDialog";
import { generatePython } from "@/lib/pipeline/codegen";

type Editing = { def: StepDef; step?: Step } | null;

/** Tools on the left, live result in the middle, recipe on the right. Shared by Clean and Transform. */
export function RecipeWorkspace({ dataset, group }: { dataset: Dataset; group: "clean" | "transform" }) {
  const { datasets, addStep, updateStep, undo, redo, pendingTool, clearPendingTool } = useStudio();
  const [editing, setEditing] = useState<Editing>(null);
  // The command palette can ask for a specific tool to open, even while this tab is already showing.
  const [handledTool, setHandledTool] = useState<string | null>(null);
  if (pendingTool && pendingTool !== handledTool) {
    setHandledTool(pendingTool);
    const def = STEP_DEFS.find((d) => d.type === pendingTool && d.group === group);
    if (def) setEditing({ def });
  }
  useEffect(() => {
    if (pendingTool) clearPendingTool();
  }, [pendingTool, clearPendingTool]);
  const [showCode, setShowCode] = useState(false);
  const [view, setView] = useState<"result" | "python">("result");
  const change = lastChange(dataset);
  const tools = STEP_DEFS.filter((d) => d.group === group);

  // Ctrl+Z / Ctrl+Y (or Ctrl+Shift+Z) outside of form fields.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || !(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) {
        e.preventDefault();
        void undo();
      } else if (k === "y" || (k === "z" && e.shiftKey)) {
        e.preventDefault();
        void redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  // Editing an existing step uses the columns that existed *before* that step.
  const stepIndex = editing?.step ? dataset.steps.findIndex((s) => s.id === editing.step!.id) : -1;
  const formCols = stepIndex >= 0 ? (dataset.schemas[stepIndex] ?? dataset.columns) : dataset.columns;

  return (
    <div className="grid h-full min-h-0 gap-4 lg:grid-cols-[15rem_minmax(0,1fr)_16rem]">
      <aside className="min-h-0 overflow-auto rounded-xl border bg-surface p-4">
        {editing ? (
          <StepForm
            key={editing.step?.id ?? editing.def.type}
            def={editing.def}
            initial={editing.step?.params ?? editing.def.defaults(formCols)}
            cols={formCols}
            dataset={dataset}
            datasets={datasets}
            submitLabel={editing.step ? "Update step" : "Add step"}
            onCancel={() => setEditing(null)}
            onSubmit={(params) => {
              if (editing.step) void updateStep(editing.step.id, params);
              else void addStep(editing.def.type, params);
              setEditing(null);
            }}
          />
        ) : (
          <>
            <h3 className="mb-2 font-semibold">{group === "clean" ? "Cleaning tools" : "Transform tools"}</h3>
            <ul className="space-y-1">
              {tools.map((t) => (
                <li key={t.type}>
                  <button
                    onClick={() => setEditing({ def: t })}
                    className="group flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-surface-2"
                  >
                    <span>
                      <span className="block text-sm font-medium">{t.label}</span>
                      <span className="block text-xs text-muted">{t.description}</span>
                    </span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted group-hover:text-accent" />
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </aside>

      <section className="flex h-[60vh] min-h-0 min-w-0 flex-col gap-2 lg:h-auto">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg border p-0.5 text-sm" role="tablist">
            {(
              [
                ["result", "Result", Table2],
                ["python", "Python code", Code2],
              ] as const
            ).map(([id, label, Icon]) => (
              <button
                key={id}
                role="tab"
                aria-selected={view === id}
                onClick={() => setView(id)}
                className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 ${view === id ? "bg-accent-soft font-medium text-accent" : "text-muted hover:text-text"}`}
              >
                <Icon className="h-3.5 w-3.5" /> {label}
              </button>
            ))}
          </div>
          <span className="text-sm text-muted">
            {dataset.rowCount.toLocaleString()} rows × {dataset.columns.length} columns
          </span>
          {change && (
            <span className="w-full min-w-0 truncate text-sm" data-testid="last-change" title={change.text}>
              <span className="text-muted">Last step:</span> {change.text}
            </span>
          )}
        </div>
        <div className="min-h-0 flex-1">
          {view === "result" ? (
            <DataTable key={`${dataset.id}:${dataset.version}`} dataset={dataset} highlight={change?.added} />
          ) : (
            <LiveCode dataset={dataset} datasets={datasets} />
          )}
        </div>
      </section>

      <aside className="min-h-0 rounded-xl border bg-surface p-4">
        <RecipePanel
          dataset={dataset}
          editingId={editing?.step?.id ?? null}
          onEdit={(step) => setEditing({ def: getStepDef(step.type), step })}
          onShowCode={() => setShowCode(true)}
        />
      </aside>

      {showCode && <CodeDialog dataset={dataset} onClose={() => setShowCode(false)} />}
    </div>
  );
}

/** What the most recent working step did to the columns, so its effect is visible even when new columns are off-screen. */
function lastChange(ds: Dataset): { text: string; added: string[] } | null {
  for (let i = ds.steps.length - 1; i >= 0; i--) {
    const step = ds.steps[i];
    if (!step.enabled || ds.stepErrors[step.id]) continue;
    const before = (ds.schemas[i] ?? []).map((c) => c.name);
    const after = (ds.schemas[i + 1] ?? ds.columns).map((c) => c.name);
    const added = after.filter((c) => !before.includes(c));
    const removed = before.filter((c) => !after.includes(c));
    const parts = [];
    if (added.length) parts.push(`added ${added.join(", ")}`);
    if (removed.length) parts.push(removed.length > 3 ? `removed ${removed.length} columns` : `removed ${removed.join(", ")}`);
    if (!parts.length) parts.push("changed values or rows (same columns)");
    return { text: parts.join("; "), added };
  }
  return null;
}

/** The recipe as pandas, regenerated on every change. */
function LiveCode({ dataset, datasets }: { dataset: Dataset; datasets: Dataset[] }) {
  const code = useMemo(() => generatePython(dataset, datasets), [dataset, datasets]);
  return (
    <pre className="h-full overflow-auto rounded-xl border bg-surface-2 p-4 text-xs leading-relaxed" data-testid="live-code">
      <code>{code}</code>
    </pre>
  );
}
