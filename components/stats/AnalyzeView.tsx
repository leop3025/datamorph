"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, CircleHelp, FlaskConical, Grid3x3, Loader2, XCircle } from "lucide-react";
import type { Dataset } from "@/lib/data/types";
import { ident, query } from "@/lib/duckdb/client";
import { callPython, frameFile } from "@/lib/python/client";
import { TEST_INFO, explain, formatP, runTest, suggestTest, type TestId, type TestRequest, type TestResult } from "@/lib/stats/tests";
import { fmt } from "@/lib/charts/builder";
import { EChart, useThemeColors, type ThemeColors } from "@/components/charts/EChart";
import { CorrelationHeatmap } from "@/components/profile/CorrelationHeatmap";
import type { EChartsOption } from "@/lib/charts/echarts";

const field = "w-full rounded-lg border bg-surface px-2.5 py-1.5 text-sm outline-none focus:border-accent";

export function AnalyzeView({ dataset }: { dataset: Dataset }) {
  return (
    <div className="h-full space-y-4 overflow-auto">
      <TestWizard dataset={dataset} />
      <CorrelationMatrix dataset={dataset} />
    </div>
  );
}

function TestWizard({ dataset }: { dataset: Dataset }) {
  const cols = dataset.columns;
  const firstNum = cols.find((c) => c.kind === "number")?.name ?? cols[0]?.name ?? "";
  const firstCat = cols.find((c) => c.kind === "category" || c.kind === "boolean")?.name ?? "";
  const [a, setA] = useState(firstNum);
  const [b, setB] = useState(firstCat);
  const [levels, setLevels] = useState<string[]>([]);
  const [pair, setPair] = useState<[string, string] | null>(null);
  const [method, setMethod] = useState<"pearson" | "spearman">("pearson");
  const [state, setState] = useState<{ req: TestRequest; result?: TestResult; error?: string; progress?: string } | null>(null);

  const kindA = cols.find((c) => c.name === a)?.kind;
  const kindB = cols.find((c) => c.name === b)?.kind;
  const groupCol = kindA === "number" ? (kindB !== "number" ? b : "") : kindB === "number" ? a : "";

  // Levels of the grouping column decide between t-test and ANOVA.
  useEffect(() => {
    if (!groupCol) return;
    let cancelled = false;
    query<{ v: string }>(
      `SELECT CAST(${ident(groupCol)} AS VARCHAR) AS v FROM ${ident(dataset.table)} WHERE ${ident(groupCol)} IS NOT NULL GROUP BY 1 ORDER BY count(*) DESC LIMIT 20`,
    ).then((rows) => {
      if (cancelled) return;
      setLevels(rows.map((r) => r.v));
      setPair(null);
    });
    return () => {
      cancelled = true;
    };
  }, [groupCol, dataset.table, dataset.version]);

  const shownLevels = groupCol ? levels : [];
  const suggested = suggestTest(kindA, b ? kindB : undefined, shownLevels.length);
  const test: TestId | null = pair ? "ttest" : suggested;
  const ttestLevels = test === "ttest" ? (pair ?? (shownLevels.slice(0, 2) as [string, string])) : undefined;

  const run = async () => {
    if (!test) return;
    const req: TestRequest = { test, a, b: b || undefined, levels: ttestLevels, method };
    setState({ req, progress: "Starting…" });
    try {
      const result = await runTest(dataset, req, (progress) => setState((s) => (s ? { ...s, progress } : s)));
      setState({ req, result });
    } catch (e) {
      setState({ req, error: (e as Error).message });
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[20rem_minmax(0,1fr)]">
      <section className="space-y-4 rounded-xl border bg-surface p-4">
        <div>
          <h3 className="flex items-center gap-2 font-semibold">
            <FlaskConical className="h-4 w-4 text-accent" /> Ask a question
          </h3>
          <p className="text-sm text-muted">Pick one or two columns and Datamorph chooses the right test.</p>
        </div>
        <label className="block space-y-1">
          <span className="text-sm font-medium">Column</span>
          <select className={field} value={a} onChange={(e) => setA(e.target.value)}>
            {cols.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name} ({c.kind})
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium">Compare with / split by</span>
          <select className={field} value={b} onChange={(e) => setB(e.target.value)}>
            <option value="">Nothing (test this column alone)</option>
            {cols
              .filter((c) => c.name !== a)
              .map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name} ({c.kind})
                </option>
              ))}
          </select>
        </label>

        {test ? (
          <div className="rounded-lg bg-accent-soft p-3 text-sm">
            <div className="font-medium text-accent">{TEST_INFO[test].name}</div>
            <div className="text-text">{TEST_INFO[test].question}</div>
          </div>
        ) : (
          <p className="rounded-lg bg-warn-soft p-3 text-sm text-warn">
            No test fits these column types. Try a number with a category, two categories, or two numbers.
          </p>
        )}

        {groupCol && shownLevels.length > 2 && (
          <div className="space-y-2 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={!!pair}
                onChange={(e) => setPair(e.target.checked ? [shownLevels[0], shownLevels[1]] : null)}
              />
              Compare just two groups (t-test)
            </label>
            {pair && (
              <div className="flex gap-2">
                {[0, 1].map((i) => (
                  <select
                    key={i}
                    className={field}
                    value={pair[i]}
                    onChange={(e) => setPair((p) => (i === 0 ? [e.target.value, p![1]] : [p![0], e.target.value]))}
                    aria-label={`Group ${i + 1}`}
                  >
                    {shownLevels.map((l) => (
                      <option key={l}>{l}</option>
                    ))}
                  </select>
                ))}
              </div>
            )}
          </div>
        )}

        {test === "correlation" && (
          <div className="flex gap-3 text-sm">
            {(["pearson", "spearman"] as const).map((m) => (
              <label key={m} className="flex items-center gap-1.5">
                <input type="radio" checked={method === m} onChange={() => setMethod(m)} />
                {m === "pearson" ? "Pearson (linear)" : "Spearman (rank)"}
              </label>
            ))}
          </div>
        )}

        <button
          onClick={run}
          disabled={!test || !!state?.progress || (test === "ttest" && ttestLevels?.[0] === ttestLevels?.[1])}
          className="w-full rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-fg disabled:opacity-40"
        >
          Run test
        </button>
        <PValueHelp />
      </section>

      <section className="min-w-0 rounded-xl border bg-surface p-5">
        {!state ? (
          <div className="flex h-full min-h-48 flex-col items-center justify-center gap-2 text-center text-sm text-muted">
            <FlaskConical className="h-8 w-8" />
            Results appear here, explained in plain English.
            <span className="text-xs">The first test downloads Python (about 30 MB, cached afterwards).</span>
          </div>
        ) : state.progress ? (
          <div className="flex h-full min-h-48 items-center justify-center gap-2 text-muted">
            <Loader2 className="h-5 w-5 animate-spin" /> {state.progress}
          </div>
        ) : state.error ? (
          <p className="rounded-lg bg-bad-soft p-3 text-sm text-bad">The test failed: {state.error}</p>
        ) : (
          <ResultCard req={state.req} result={state.result!} kindA={cols.find((c) => c.name === state.req.a)?.kind} />
        )}
      </section>
    </div>
  );
}

function ResultCard({ req, result: r, kindA }: { req: TestRequest; result: TestResult; kindA?: Dataset["columns"][number]["kind"] }) {
  const e = explain(req, r, kindA);
  const theme = useThemeColors();
  const option = useMemo(() => resultChart(req, r, theme, kindA), [req, r, theme, kindA]);
  const isNormality = req.test === "normality";
  const good = isNormality ? !e.significant : e.significant;
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        {good ? (
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-good" aria-label={isNormality ? "Normal" : "Significant"} />
        ) : (
          <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-muted" aria-label={isNormality ? "Not normal" : "Not significant"} />
        )}
        <p className="text-lg leading-snug" data-testid="headline">
          {e.headline}
        </p>
      </div>

      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Test" value={r.test} />
        <Stat label="Statistic" value={fmt(r.statistic)} />
        <Stat label="p-value" value={formatP(r.p).replace("p ", "").replace("= ", "")} />
        {r.effect?.value != null ? (
          <Stat label={r.effect.name} value={r.effect.value.toFixed(3)} />
        ) : (
          <Stat label="Rows" value={(r.n ?? r.groups?.reduce((s, g) => s + g.n, 0) ?? 0).toLocaleString()} />
        )}
      </dl>

      <ul className="space-y-1 text-sm">
        {e.details.map((d, i) => (
          <li key={i}>{d}</li>
        ))}
      </ul>
      {e.cautions.map((c, i) => (
        <p key={i} className="flex items-start gap-2 rounded-lg bg-warn-soft px-3 py-2 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warn" /> {c}
        </p>
      ))}

      {option && <EChart option={option} className="h-80 w-full" />}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-surface-2 px-3 py-2">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="truncate font-medium tabular-nums" title={value}>
        {value}
      </dd>
    </div>
  );
}

function PValueHelp() {
  return (
    <details className="rounded-lg border p-3 text-sm">
      <summary className="flex cursor-pointer items-center gap-1.5 font-medium">
        <CircleHelp className="h-4 w-4 text-accent" /> What is a p-value?
      </summary>
      <p className="mt-2 text-muted">
        The p-value is the chance of seeing a difference this big <em>if there were really no difference</em>. Below 0.05
        (5%) we call the result statistically significant: it&apos;s unlikely to be a fluke. It does not tell you how big
        or important the effect is; the effect size does that.
      </p>
    </details>
  );
}

function resultChart(req: TestRequest, r: TestResult, t: ThemeColors, kindA?: string): EChartsOption | null {
  const axis = { axisLabel: { color: t.muted }, axisLine: { lineStyle: { color: t.border } }, splitLine: { lineStyle: { color: t.grid } } };
  const base = { backgroundColor: "transparent", textStyle: { color: t.text, fontFamily: "inherit" }, grid: { left: 8, right: 16, top: 24, bottom: 8, containLabel: true } };

  if ((req.test === "ttest" || req.test === "anova") && r.groups) {
    const value = kindA === "number" ? req.a : req.b;
    return {
      ...base,
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "shadow" },
        formatter: (ps: { dataIndex: number }[]) => {
          const g = r.groups![ps[0].dataIndex];
          return `<b>${g.group}</b><br/>mean ${fmt(g.mean)} · median ${fmt(g.median)}<br/>std ${fmt(g.std)} · n ${g.n.toLocaleString()}`;
        },
      },
      xAxis: { type: "category", data: r.groups.map((g) => g.group), ...axis, axisTick: { show: false } },
      yAxis: { type: "value", name: `Average ${value}`, nameTextStyle: { color: t.muted }, ...axis },
      series: [
        {
          type: "bar",
          data: r.groups.map((g) => g.mean),
          itemStyle: { color: t.series[0], borderRadius: [4, 4, 0, 0] },
          barMaxWidth: 56,
          label: { show: true, position: "top", color: t.text, formatter: (p: { value: number }) => fmt(p.value) },
        },
      ],
    };
  }
  if (req.test === "chisquare" && r.table) {
    const { rows, cols, row_pct } = r.table;
    // Labels switch to white on the darker half of the ramp so they stay readable.
    const data = row_pct.flatMap((row, i) =>
      row.map((v, j) => ({ value: [j, i, v], label: { color: v > 50 ? "#ffffff" : "#0b0b0b" } })),
    );
    return {
      ...base,
      grid: { ...base.grid, right: 72, bottom: 16 },
      tooltip: { formatter: (p: { value: number[] }) => `${req.a} = ${rows[p.value[1]]}<br/>${req.b} = ${cols[p.value[0]]}<br/><b>${p.value[2]}% of row</b>` },
      xAxis: { type: "category", data: cols, name: req.b, nameLocation: "middle", nameGap: 28, nameTextStyle: { color: t.muted }, ...axis },
      yAxis: { type: "category", data: rows, name: req.a, nameTextStyle: { color: t.muted }, ...axis },
      visualMap: { min: 0, max: 100, orient: "vertical", right: 0, top: "middle", itemHeight: 120, textStyle: { color: t.muted }, formatter: (v: number) => `${Math.round(v)}%`, inRange: { color: ["#cde2fb", "#3987e5", "#0d366b"] } },
      series: [{ type: "heatmap", data, label: { show: rows.length * cols.length <= 60, formatter: (p: { value: number[] }) => `${p.value[2]}%` }, itemStyle: { borderColor: t.surface, borderWidth: 2 } }],
    };
  }
  if (req.test === "correlation" && r.points && r.fit) {
    const xs = r.points.map((p) => p[0]);
    const [lo, hi] = [Math.min(...xs), Math.max(...xs)];
    return {
      ...base,
      tooltip: { trigger: "item" },
      xAxis: { type: "value", name: req.a, nameLocation: "middle", nameGap: 28, nameTextStyle: { color: t.muted }, scale: true, ...axis },
      yAxis: { type: "value", name: req.b, nameTextStyle: { color: t.muted }, scale: true, ...axis },
      series: [
        { type: "scatter", data: r.points, symbolSize: 7, itemStyle: { color: t.series[0], opacity: 0.6, borderColor: t.surface, borderWidth: 1 } },
        { type: "line", data: [[lo, r.fit.intercept + r.fit.slope * lo], [hi, r.fit.intercept + r.fit.slope * hi]], showSymbol: false, lineStyle: { color: t.series[1], width: 2 }, tooltip: { show: false } },
      ],
    };
  }
  if (req.test === "normality" && r.qq) {
    const { theoretical: x, observed: y, slope, intercept } = r.qq;
    const [lo, hi] = [x[0], x[x.length - 1]];
    return {
      ...base,
      tooltip: { trigger: "item" },
      xAxis: { type: "value", name: "Theoretical quantiles (normal)", nameLocation: "middle", nameGap: 28, nameTextStyle: { color: t.muted }, ...axis },
      yAxis: { type: "value", name: `Observed ${req.a}`, nameTextStyle: { color: t.muted }, scale: true, ...axis },
      series: [
        { type: "scatter", data: x.map((v, i) => [v, y[i]]), symbolSize: 6, itemStyle: { color: t.series[0], opacity: 0.7 } },
        { type: "line", data: [[lo, intercept + slope * lo], [hi, intercept + slope * hi]], showSymbol: false, lineStyle: { color: t.series[1], width: 2 }, tooltip: { show: false } },
      ],
    };
  }
  return null;
}

function CorrelationMatrix({ dataset }: { dataset: Dataset }) {
  const [method, setMethod] = useState<"pearson" | "spearman" | "cramers_v">("pearson");
  const [state, setState] = useState<{ data?: { columns: string[]; matrix: (number | null)[][] }; progress?: string; error?: string; method?: string } | null>(null);
  const numeric = dataset.columns.filter((c) => c.kind === "number").map((c) => c.name).slice(0, 20);
  const categorical = dataset.columns.filter((c) => c.kind === "category" || c.kind === "boolean").map((c) => c.name).slice(0, 15);
  const columns = method === "cramers_v" ? categorical : numeric;

  const run = async () => {
    setState({ progress: "Starting…" });
    try {
      const path = `/data/${dataset.table}_v${dataset.version}_matrix_${method}.csv`;
      const { file, dates } = await frameFile(dataset, columns, path, 100_000);
      const data = await callPython<{ columns: string[]; matrix: (number | null)[][] }>(
        "corr_matrix",
        { path, dates, fresh: true, columns, method },
        { packages: ["scipy"], sections: ["stats"], files: [file], onProgress: (progress) => setState({ progress }) },
      );
      setState({ data, method });
    } catch (e) {
      setState({ error: (e as Error).message });
    }
  };

  return (
    <section className="rounded-xl border bg-surface p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="flex items-center gap-2 font-semibold">
            <Grid3x3 className="h-4 w-4 text-accent" /> Correlation matrix
          </h3>
          <p className="text-sm text-muted">
            {method === "pearson"
              ? "Pearson: straight-line relationships between numbers."
              : method === "spearman"
                ? "Spearman: any consistently rising or falling relationship (rank-based, robust to outliers)."
                : "Cramér's V: association between categories, from 0 (none) to 1 (perfect)."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select className="rounded-lg border bg-surface px-2 py-1.5 text-sm" value={method} onChange={(e) => setMethod(e.target.value as typeof method)} aria-label="Method">
            <option value="pearson">Pearson</option>
            <option value="spearman">Spearman</option>
            <option value="cramers_v">Cramér&apos;s V (categories)</option>
          </select>
          <button
            onClick={run}
            disabled={columns.length < 2 || !!state?.progress}
            className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg disabled:opacity-40"
          >
            Compute
          </button>
        </div>
      </div>
      {columns.length < 2 ? (
        <p className="text-sm text-muted">Needs at least two {method === "cramers_v" ? "category" : "numeric"} columns.</p>
      ) : state?.progress ? (
        <p className="flex items-center gap-2 text-sm text-muted">
          <Loader2 className="h-4 w-4 animate-spin" /> {state.progress}
        </p>
      ) : state?.error ? (
        <p className="text-sm text-bad">{state.error}</p>
      ) : state?.data ? (
        <CorrelationHeatmap data={state.data} sequential={state.method === "cramers_v"} />
      ) : null}
    </section>
  );
}
