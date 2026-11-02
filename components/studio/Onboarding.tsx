"use client";

import { useState } from "react";
import { CheckCircle2, Circle, GraduationCap, X } from "lucide-react";
import { useStudio } from "@/lib/store/studio";

const KEY = "datamorph.onboarding.dismissed";

/** A self-checking "first analysis" checklist for beginners. Each item ticks itself as you go. */
export function Onboarding() {
  const { datasets, visited, widgets } = useStudio();
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(KEY) === "1";
    } catch {
      return false;
    }
  });
  if (dismissed) return null;

  const items = [
    { done: datasets.length > 0, label: "Load a dataset (try a sample)" },
    { done: datasets.length > 0, label: "Read the profile: quality score and warnings" },
    { done: datasets.some((d) => d.steps.length > 0), label: "Fix an issue (click a warning's fix button)" },
    { done: widgets.length > 0 || !!visited.visualize, label: "Build a chart in Visualise" },
    { done: !!visited.analyze, label: "Run a statistical test in Analyse" },
    { done: !!visited.ml, label: "Train a model in ML studio" },
  ];
  const n = items.filter((i) => i.done).length;

  const close = () => {
    setDismissed(true);
    try {
      localStorage.setItem(KEY, "1");
    } catch {}
  };

  return (
    <div className="mt-4 rounded-xl border bg-surface-2 p-3 text-sm print:hidden" data-testid="onboarding">
      <div className="mb-2 flex items-center justify-between">
        <span className="flex items-center gap-1.5 font-medium">
          <GraduationCap className="h-4 w-4 text-accent" /> First analysis
        </span>
        <button onClick={close} className="rounded p-0.5 text-muted hover:text-text" aria-label="Dismiss guide">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-surface">
        <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${(n / items.length) * 100}%` }} />
      </div>
      <ul className="space-y-1">
        {items.map((i) => (
          <li key={i.label} className={`flex items-start gap-1.5 ${i.done ? "text-muted line-through" : ""}`}>
            {i.done ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-good" /> : <Circle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" />}
            {i.label}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-muted">Tip: press Ctrl+K for the command palette.</p>
    </div>
  );
}
