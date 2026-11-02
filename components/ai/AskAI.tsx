"use client";

import { useMemo, useState } from "react";
import { Bot, KeyRound, Lightbulb, Loader2, Play, Send, ShieldCheck, User } from "lucide-react";
import type { Dataset } from "@/lib/data/types";
import { AIError, askQuestion, autoInsights, loadSettings, runSafeSelect, saveSettings, type AISettings, type Insight } from "@/lib/ai/client";
import { useStudio } from "@/lib/store/studio";
import { fmt } from "@/lib/charts/builder";
import { EChart, useThemeColors } from "@/components/charts/EChart";
import type { EChartsOption } from "@/lib/charts/echarts";

interface Turn {
  id: number;
  question: string;
  state: "loading" | "done" | "error";
  sql?: string;
  explanation?: string;
  rows?: Record<string, unknown>[];
  columns?: string[];
  error?: string;
  code?: string;
}

export function AskAI({ dataset }: { dataset: Dataset }) {
  const datasets = useStudio((s) => s.datasets);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [q, setQ] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [insights, setInsights] = useState<{ loading?: boolean; items?: Insight[]; error?: string; code?: string } | null>(null);

  const suggestions = useMemo(() => {
    const num = dataset.columns.find((c) => c.kind === "number" && !/(^|_)id$/i.test(c.name))?.name;
    const cat = dataset.columns.find((c) => c.kind === "category")?.name;
    const date = dataset.columns.find((c) => c.kind === "date")?.name;
    const out: string[] = [];
    if (cat && num) out.push(`Which ${cat} has the highest total ${num}?`, `Average ${num} by ${cat}`);
    if (date && num) out.push(`How does total ${num} change by month?`);
    if (cat) out.push(`How many rows are there per ${cat}?`);
    return out.slice(0, 4);
  }, [dataset]);

  const ask = async (question: string) => {
    if (!question.trim()) return;
    const id = Date.now();
    setQ("");
    setTurns((t) => [...t, { id, question, state: "loading" }]);
    try {
      const a = await askQuestion(question, dataset, datasets);
      setTurns((t) => t.map((x) => (x.id === id ? { ...x, state: "done", ...a } : x)));
    } catch (e) {
      const err = e as AIError;
      setTurns((t) => t.map((x) => (x.id === id ? { ...x, state: "error", error: err.message, code: err.code } : x)));
    }
  };

  const rerun = async (id: number, sql: string) => {
    try {
      const res = await runSafeSelect(sql, datasets);
      setTurns((t) => t.map((x) => (x.id === id ? { ...x, state: "done", error: undefined, ...res } : x)));
    } catch (e) {
      setTurns((t) => t.map((x) => (x.id === id ? { ...x, error: (e as Error).message.split("\n")[0] } : x)));
    }
  };

  const generateInsights = async () => {
    setInsights({ loading: true });
    try {
      setInsights({ items: await autoInsights(dataset) });
    } catch (e) {
      setInsights({ error: (e as Error).message, code: (e as AIError).code });
    }
  };

  return (
    <div className="grid h-full min-h-0 gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <section className="flex min-h-0 flex-col rounded-xl border bg-surface">
        <div className="flex items-center justify-between gap-2 border-b px-4 py-2.5">
          <span className="flex items-center gap-2 text-sm text-muted">
            <ShieldCheck className="h-4 w-4 text-good" /> Only column names and summary statistics go to the AI. Queries run locally.
          </span>
          <button onClick={() => setShowSettings((v) => !v)} className="inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-xs hover:bg-surface-2">
            <KeyRound className="h-3.5 w-3.5" /> AI settings
          </button>
        </div>
        {showSettings && <Settings onClose={() => setShowSettings(false)} />}

        <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
          {turns.length === 0 && (
            <div className="py-6 text-center">
              <Bot className="mx-auto mb-2 h-8 w-8 text-accent" />
              <p className="font-medium">Ask a question about {dataset.name} in plain English</p>
              <p className="text-sm text-muted">You&apos;ll get the answer, the SQL behind it (editable), and a chart.</p>
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                {suggestions.map((s) => (
                  <button key={s} onClick={() => ask(s)} className="rounded-full border px-3 py-1 text-sm hover:bg-surface-2">
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          {turns.map((t) => (
            <TurnView key={t.id} turn={t} onRun={(sql) => rerun(t.id, sql)} onSettings={() => setShowSettings(true)} />
          ))}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void ask(q);
          }}
          className="flex gap-2 border-t p-3"
        >
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="e.g. Which region had the highest sales growth in 2024?"
            className="flex-1 rounded-lg border bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
            aria-label="Question"
          />
          <button className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-fg" disabled={!q.trim()}>
            <Send className="h-4 w-4" /> Ask
          </button>
        </form>
      </section>

      <aside className="min-h-0 overflow-auto rounded-xl border bg-surface p-4">
        <h3 className="flex items-center gap-2 font-semibold">
          <Lightbulb className="h-4 w-4 text-accent" /> Auto insights
        </h3>
        <p className="mb-3 text-sm text-muted">Datamorph computes group totals, trends and correlations locally, then the AI writes up the most useful findings.</p>
        <button
          onClick={generateInsights}
          disabled={insights?.loading}
          className="w-full rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-fg disabled:opacity-40"
        >
          {insights?.loading ? "Analysing…" : "Generate insights"}
        </button>
        {insights?.error && <ErrorNote message={insights.error} code={insights.code} onSettings={() => setShowSettings(true)} />}
        <ul className="mt-3 space-y-2" data-testid="insights">
          {insights?.items?.map((i, n) => (
            <li key={n} className="rounded-lg border p-3 text-sm">
              <div className="font-medium">{i.title}</div>
              <div className="text-muted">{i.detail}</div>
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}

function TurnView({ turn, onRun, onSettings }: { turn: Turn; onRun: (sql: string) => void; onSettings: () => void }) {
  const [sql, setSql] = useState(turn.sql ?? "");
  const [lastSql, setLastSql] = useState(turn.sql);
  // Keep the editor in sync when a new answer arrives.
  if (turn.sql !== lastSql) {
    setLastSql(turn.sql);
    setSql(turn.sql ?? "");
  }
  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2">
        <User className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
        <p className="font-medium">{turn.question}</p>
      </div>
      <div className="flex items-start gap-2">
        <Bot className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
        <div className="min-w-0 flex-1 space-y-2">
          {turn.state === "loading" && (
            <p className="flex items-center gap-2 text-sm text-muted">
              <Loader2 className="h-4 w-4 animate-spin" /> Writing SQL…
            </p>
          )}
          {turn.state === "error" && !turn.sql && <ErrorNote message={turn.error!} code={turn.code} onSettings={onSettings} />}
          {turn.sql !== undefined && (
            <>
              {turn.explanation && <p className="text-sm">{turn.explanation}</p>}
              <div className="rounded-lg border">
                <textarea
                  value={sql}
                  onChange={(e) => setSql(e.target.value)}
                  rows={Math.min(8, sql.split("\n").length + 1)}
                  className="w-full resize-y rounded-t-lg bg-surface-2 p-2 font-mono text-xs outline-none"
                  aria-label="SQL"
                  spellCheck={false}
                />
                <div className="flex items-center justify-between border-t px-2 py-1">
                  <span className="text-xs text-muted">Read-only SQL, runs in DuckDB in your browser</span>
                  <button onClick={() => onRun(sql)} className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium text-accent hover:bg-accent-soft">
                    <Play className="h-3 w-3" /> Run
                  </button>
                </div>
              </div>
              {turn.error && <p className="text-sm text-bad">{turn.error}</p>}
              {turn.rows && <ResultView rows={turn.rows} columns={turn.columns ?? []} />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function ErrorNote({ message, code, onSettings }: { message: string; code?: string; onSettings: () => void }) {
  return (
    <div className="mt-2 rounded-lg bg-bad-soft p-3 text-sm text-bad">
      {message}
      {code === "no_key" && (
        <button onClick={onSettings} className="ml-1 font-medium underline">
          Add a key
        </button>
      )}
    </div>
  );
}

export function ResultView({ rows, columns }: { rows: Record<string, unknown>[]; columns: string[] }) {
  const t = useThemeColors();
  // Auto chart: a label column followed by a numeric column.
  const option = useMemo<EChartsOption | null>(() => {
    if (rows.length < 2 || rows.length > 60 || columns.length < 2) return null;
    const label = columns.find((c) => typeof rows[0][c] !== "number");
    const value = columns.find((c) => typeof rows[0][c] === "number" && c !== label);
    if (!label || !value) return null;
    const xs = rows.map((r) => String(r[label]));
    const timeLike = xs.every((x) => /^\d{4}(-\d{2})?(-\d{2})?/.test(x));
    return {
      backgroundColor: "transparent",
      textStyle: { color: t.text, fontFamily: "inherit" },
      grid: { left: 8, right: 16, top: 16, bottom: 8, containLabel: true },
      tooltip: { trigger: "axis", valueFormatter: (v: number) => fmt(v) },
      xAxis: { type: "category", data: xs, axisLabel: { color: t.muted, rotate: xs.length > 8 ? 35 : 0, hideOverlap: true }, axisLine: { lineStyle: { color: t.border } } },
      yAxis: { type: "value", name: value, nameTextStyle: { color: t.muted }, axisLabel: { color: t.muted }, splitLine: { lineStyle: { color: t.grid } } },
      series: [
        timeLike
          ? { type: "line", data: rows.map((r) => r[value]), lineStyle: { width: 2, color: t.series[0] }, itemStyle: { color: t.series[0] }, showSymbol: rows.length < 30 }
          : { type: "bar", data: rows.map((r) => r[value]), itemStyle: { color: t.series[0], borderRadius: [4, 4, 0, 0] }, barMaxWidth: 40 },
      ],
    };
  }, [rows, columns, t]);

  return (
    <div className="space-y-2">
      <div className="max-h-64 overflow-auto rounded-lg border">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-surface-2">
            <tr>
              {columns.map((c) => (
                <th key={c} className={`px-2 py-1.5 font-medium ${typeof rows[0]?.[c] === "number" ? "text-right" : "text-left"}`}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 100).map((r, i) => (
              <tr key={i} className="border-t">
                {columns.map((c) => (
                  <td key={c} className={`whitespace-nowrap px-2 py-1 ${typeof r[c] === "number" ? "text-right font-mono tabular-nums" : ""}`}>
                    {r[c] === null ? <span className="text-muted">–</span> : typeof r[c] === "number" ? fmt(r[c] as number) : String(r[c])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted">
        {rows.length.toLocaleString()} row{rows.length === 1 ? "" : "s"}
        {rows.length > 100 && " (showing 100)"}
      </p>
      {option && <EChart option={option} className="h-64 w-full" />}
    </div>
  );
}

function Settings({ onClose }: { onClose: () => void }) {
  const [s, setS] = useState<AISettings>(loadSettings);
  return (
    <div className="space-y-2 border-b bg-surface-2 p-4 text-sm">
      <p className="text-muted">
        By default the site&apos;s free AI key is used (rate-limited). You can use your own free key from{" "}
        <a className="text-accent underline" href="https://console.groq.com/keys" target="_blank" rel="noreferrer">Groq</a> or{" "}
        <a className="text-accent underline" href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">Google AI Studio</a>. It&apos;s stored only in this browser.
      </p>
      <div className="flex flex-wrap gap-2">
        <select className="rounded-lg border bg-surface px-2 py-1.5" value={s.provider} onChange={(e) => setS({ ...s, provider: e.target.value as AISettings["provider"] })} aria-label="Provider">
          <option value="groq">Groq</option>
          <option value="gemini">Google Gemini</option>
        </select>
        <input
          type="password"
          value={s.key}
          onChange={(e) => setS({ ...s, key: e.target.value })}
          placeholder="Your API key (optional)"
          className="min-w-48 flex-1 rounded-lg border bg-surface px-2 py-1.5"
          aria-label="API key"
        />
        <button
          onClick={() => {
            saveSettings(s);
            onClose();
          }}
          className="rounded-lg bg-accent px-3 py-1.5 font-medium text-accent-fg"
        >
          Save
        </button>
      </div>
    </div>
  );
}
