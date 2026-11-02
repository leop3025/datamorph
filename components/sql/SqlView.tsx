"use client";

import { useRef, useState } from "react";
import { Database, ListPlus, Loader2, Play, Sparkles } from "lucide-react";
import type { Dataset } from "@/lib/data/types";
import { AIError, askQuestion, runSafeSelect } from "@/lib/ai/client";
import { validateSelect } from "@/lib/ai/sql";
import { py } from "@/lib/pipeline/literals";
import { useStudio } from "@/lib/store/studio";
import { ErrorNote, ResultView } from "@/components/ai/AskAI";
import { KindBadge } from "@/components/data-table/KindBadge";

interface Result {
  rows: Record<string, unknown>[];
  columns: string[];
  ms: number;
}

const quote = (name: string) => (/^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`);

/** Plain English → SQL (AI), or write SQL yourself; it runs locally and can become a recipe step. */
export function SqlView({ dataset }: { dataset: Dataset }) {
  const { datasets, addStep, setTab } = useStudio();
  const [question, setQuestion] = useState("");
  const [sql, setSql] = useState(`SELECT *\nFROM ${quote(dataset.table)}\nLIMIT 100`);
  const [explanation, setExplanation] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [busy, setBusy] = useState<"ai" | "run" | null>(null);
  const editor = useRef<HTMLTextAreaElement>(null);

  const run = async (text = sql) => {
    setBusy("run");
    setError(null);
    const t0 = performance.now();
    try {
      const res = await runSafeSelect(text, datasets);
      setResult({ rows: res.rows, columns: res.columns, ms: performance.now() - t0 });
    } catch (e) {
      setResult(null);
      setError({ message: (e as Error).message.split("\n")[0] });
    } finally {
      setBusy(null);
    }
  };

  const generate = async () => {
    if (!question.trim()) return;
    setBusy("ai");
    setError(null);
    try {
      const a = await askQuestion(question, dataset, datasets);
      setSql(a.sql);
      setExplanation(a.explanation);
      setResult({ rows: a.rows, columns: a.columns, ms: 0 });
    } catch (e) {
      setError({ message: (e as Error).message, code: (e as AIError).code });
    } finally {
      setBusy(null);
    }
  };

  const insert = (text: string) => {
    const el = editor.current;
    if (!el) return setSql((s) => s + text);
    const { selectionStart: a, selectionEnd: b } = el;
    setSql(sql.slice(0, a) + text + sql.slice(b));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(a + text.length, a + text.length);
    });
  };

  // A recipe step can only read this dataset (other datasets come in through Join).
  const stepCheck = validateSelect(sql, ["data", dataset.table]);
  const addToRecipe = async () => {
    await addStep("sql", { query: stepCheck.sql, alias: dataset.table });
    setTab("transform");
  };

  const pythonName = /^[A-Za-z_]\w*$/.test(dataset.table) ? dataset.table : "data";

  return (
    <div className="grid h-full min-h-0 gap-4 lg:grid-cols-[15rem_minmax(0,1fr)]">
      <aside className="min-h-0 overflow-auto rounded-xl border bg-surface p-4">
        <h3 className="mb-1 flex items-center gap-2 font-semibold">
          <Database className="h-4 w-4 text-accent" /> Tables
        </h3>
        <p className="mb-3 text-xs text-muted">Click a name to insert it into the query.</p>
        {datasets.map((d) => (
          <div key={d.id} className="mb-3">
            <button onClick={() => insert(quote(d.table))} className="font-mono text-sm font-medium text-accent hover:underline">
              {d.table}
            </button>
            <span className="ml-1 text-xs text-muted">{d.rowCount.toLocaleString()} rows</span>
            <ul className="mt-1 space-y-0.5">
              {d.columns.map((c) => (
                <li key={c.name}>
                  <button onClick={() => insert(quote(c.name))} className="flex w-full items-center justify-between gap-2 rounded px-1 py-0.5 text-left text-xs hover:bg-surface-2">
                    <span className="truncate font-mono">{c.name}</span>
                    <KindBadge kind={c.kind} />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </aside>

      <section className="min-h-0 space-y-3 overflow-auto rounded-xl border bg-surface p-4">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void generate();
          }}
          className="flex gap-2"
        >
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder={`Ask in plain English, e.g. "total revenue per region, highest first"`}
            className="flex-1 rounded-lg border bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
            aria-label="Question in plain English"
          />
          <button
            disabled={!question.trim() || busy !== null}
            className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-fg disabled:opacity-40"
          >
            {busy === "ai" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} Write SQL
          </button>
        </form>
        {explanation && <p className="text-sm text-muted">{explanation}</p>}

        <div className="rounded-lg border">
          <textarea
            ref={editor}
            value={sql}
            onChange={(e) => setSql(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                e.preventDefault();
                void run();
              }
            }}
            rows={8}
            spellCheck={false}
            className="w-full resize-y rounded-t-lg bg-surface-2 p-3 font-mono text-sm outline-none"
            aria-label="SQL"
          />
          <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2">
            <button
              onClick={() => run()}
              disabled={busy !== null}
              className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg disabled:opacity-40"
            >
              {busy === "run" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} Run
            </button>
            <button
              onClick={addToRecipe}
              disabled={!stepCheck.ok}
              title={stepCheck.ok ? "Replace the data with this query's result, as a step you can undo" : stepCheck.reason}
              className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm hover:bg-surface-2 disabled:opacity-40"
            >
              <ListPlus className="h-4 w-4" /> Add to recipe
            </button>
            <span className="text-xs text-muted">Ctrl+Enter to run · read-only, runs in DuckDB in your browser</span>
          </div>
        </div>

        {error && <ErrorNote message={error.message} code={error.code} onSettings={() => setTab("ai")} />}
        {result && (
          <>
            {result.ms > 0 && <p className="text-xs text-muted">Ran in {Math.round(result.ms)} ms</p>}
            <ResultView rows={result.rows} columns={result.columns} />
          </>
        )}

        <details className="rounded-lg border p-3 text-sm">
          <summary className="cursor-pointer font-medium">Python equivalent</summary>
          <pre className="mt-2 overflow-auto rounded bg-surface-2 p-3 text-xs">
            <code>{`import duckdb  # pip install duckdb\n\n# ${pythonName} is your DataFrame; duckdb finds it by variable name\nresult = duckdb.sql(${py(validateSelect(sql, []).sql)}).df()\nprint(result)`}</code>
          </pre>
        </details>
      </section>
    </div>
  );
}
