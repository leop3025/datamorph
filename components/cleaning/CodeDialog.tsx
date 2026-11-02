"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, BadgeCheck, Check, Copy, Download, FileCode2, Loader2, NotebookPen, ShieldCheck, X } from "lucide-react";
import { verifyRecipe, type Verification } from "@/lib/pipeline/verify";
import type { Dataset } from "@/lib/data/types";
import { generateNotebook, generatePython } from "@/lib/pipeline/codegen";
import { download, exportDataset, type ExportFormat } from "@/lib/data/export";
import { useStudio } from "@/lib/store/studio";

export function CodeDialog({ dataset, onClose }: { dataset: Dataset; onClose: () => void }) {
  const datasets = useStudio((s) => s.datasets);
  const code = useMemo(() => generatePython(dataset, datasets), [dataset, datasets]);
  const [copied, setCopied] = useState(false);
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  const [verify, setVerify] = useState<{ progress?: string; result?: Verification; error?: string } | null>(null);

  const runVerify = async () => {
    setVerify({ progress: "Starting…" });
    try {
      const result = await verifyRecipe(dataset, datasets, (progress) => setVerify({ progress }));
      setVerify({ result });
    } catch (e) {
      setVerify({ error: (e as Error).message });
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const copy = async () => {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(code);
    } else {
      // navigator.clipboard is missing outside secure contexts (e.g. http://192.168.x.x), so fall back to a hidden textarea.
      const area = Object.assign(document.createElement("textarea"), { value: code });
      document.body.append(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const exportData = async (f: ExportFormat) => {
    setExporting(f);
    try {
      await exportDataset(dataset, f);
    } finally {
      setExporting(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Generated code"
        className="flex max-h-[90dvh] w-full max-w-3xl flex-col rounded-xl border bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b p-4">
          <div>
            <h2 className="text-lg font-semibold">Your recipe as Python</h2>
            <p className="text-sm text-muted">
              pandas code that reproduces every step. Run it in Jupyter, Colab or any Python environment.
            </p>
          </div>
          <button onClick={onClose} className="rounded p-1 text-muted hover:bg-surface-2" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <VerifyBar state={verify} onRun={runVerify} />

        <pre className="min-h-0 flex-1 overflow-auto bg-surface-2 p-4 font-mono text-[13px] leading-relaxed">
          <code>{code}</code>
        </pre>

        <div className="flex flex-wrap items-center gap-2 border-t p-4">
          <button onClick={copy} className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm hover:bg-surface-2">
            {copied ? <Check className="h-4 w-4 text-good" /> : <Copy className="h-4 w-4" />} {copied ? "Copied" : "Copy"}
          </button>
          <button
            onClick={() => download(code, `${dataset.table}_recipe.py`, "text/x-python")}
            className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm hover:bg-surface-2"
          >
            <FileCode2 className="h-4 w-4" /> Download .py
          </button>
          <button
            onClick={() => download(generateNotebook(dataset, datasets), `${dataset.table}_recipe.ipynb`, "application/x-ipynb+json")}
            className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-fg"
          >
            <NotebookPen className="h-4 w-4" /> Download notebook (.ipynb)
          </button>
          <span className="ml-auto flex items-center gap-1 text-sm text-muted">
            <Download className="h-4 w-4" /> Cleaned data:
            {(["csv", "parquet", "xlsx"] as ExportFormat[]).map((f) => (
              <button
                key={f}
                disabled={!!exporting}
                onClick={() => exportData(f)}
                className="rounded px-1.5 py-0.5 font-medium text-accent hover:bg-accent-soft disabled:opacity-50"
              >
                {exporting === f ? "…" : f.toUpperCase()}
              </button>
            ))}
          </span>
        </div>
      </div>
    </div>
  );
}

function VerifyBar({
  state,
  onRun,
}: {
  state: { progress?: string; result?: Verification; error?: string } | null;
  onRun: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-b px-4 py-2.5 text-sm" data-testid="verify">
      {!state ? (
        <>
          <ShieldCheck className="h-4 w-4 text-accent" />
          <span className="text-muted">Run this code with real pandas (in your browser) and compare it with Datamorph&apos;s result.</span>
          <button onClick={onRun} className="ml-auto rounded-lg border px-3 py-1 font-medium hover:bg-surface-2">
            Verify in Python
          </button>
        </>
      ) : state.progress ? (
        <span className="flex items-center gap-2 text-muted">
          <Loader2 className="h-4 w-4 animate-spin" /> {state.progress}
        </span>
      ) : state.error ? (
        <span className="flex items-center gap-2 text-bad">
          <AlertTriangle className="h-4 w-4" /> The code raised an error in Python: {state.error}
        </span>
      ) : state.result!.ok ? (
        <span className="flex items-center gap-2 text-good">
          <BadgeCheck className="h-4 w-4" /> Verified: pandas produced the same {state.result!.pandas.rows.toLocaleString()} rows ×{" "}
          {state.result!.pandas.columns.length} columns, with matching column totals.
        </span>
      ) : (
        <div className="space-y-1 text-warn">
          <span className="flex items-center gap-2 font-medium">
            <AlertTriangle className="h-4 w-4" /> pandas and DuckDB disagree:
          </span>
          <ul className="list-disc pl-8 text-text">
            {state.result!.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
