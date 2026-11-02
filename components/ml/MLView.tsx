"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Code2, Download, Loader2, Sparkles, Trophy } from "lucide-react";
import type { ColumnInfo, Dataset } from "@/lib/data/types";
import {
  METRIC_LABELS,
  pipelineCode,
  predictDataset,
  predictRows,
  runAnomalies,
  runClusters,
  runEmbedding,
  trainAutoML,
  type AnomalyResult,
  type AutoMLResult,
  type ClusterResult,
  type EmbedResult,
} from "@/lib/ml/ml";
import { fmt } from "@/lib/charts/builder";
import { download } from "@/lib/data/export";
import { ident, query } from "@/lib/duckdb/client";
import { useStudio } from "@/lib/store/studio";
import { EChart, useThemeColors, type ThemeColors } from "@/components/charts/EChart";
import type { EChartsOption } from "@/lib/charts/echarts";
import { ForecastPanel } from "./ForecastPanel";
import { InfoTip } from "@/components/InfoTip";

type Sub = "automl" | "clusters" | "embed" | "anomalies" | "forecast";
const SUBS: { id: Sub; label: string }[] = [
  { id: "automl", label: "Predict (AutoML)" },
  { id: "clusters", label: "Clusters" },
  { id: "embed", label: "PCA / t-SNE" },
  { id: "anomalies", label: "Anomalies" },
  { id: "forecast", label: "Time series" },
];

const field = "w-full rounded-lg border bg-surface px-2.5 py-1.5 text-sm outline-none focus:border-accent";
const card = "rounded-xl border bg-surface p-4";

/** Columns that make poor features: identifiers and free text. */
function defaultFeatures(cols: ColumnInfo[], exclude: string[]) {
  return cols
    .filter((c) => !exclude.includes(c.name) && c.kind !== "text" && !/(^|_)id$|^id$|uuid/i.test(c.name))
    .map((c) => c.name);
}

export function MLView({ dataset }: { dataset: Dataset }) {
  const [sub, setSub] = useState<Sub>("automl");
  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-wrap gap-1">
        {SUBS.map((s) => (
          <button
            key={s.id}
            onClick={() => setSub(s.id)}
            className={`rounded-full border px-3 py-1 text-sm ${sub === s.id ? "border-accent bg-accent-soft text-accent" : "hover:bg-surface-2"}`}
          >
            {s.label}
          </button>
        ))}
        <span className="ml-auto self-center text-xs text-muted">scikit-learn running in your browser</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {sub === "automl" && <AutoMLPanel dataset={dataset} />}
        {sub === "clusters" && <ClustersPanel dataset={dataset} />}
        {sub === "embed" && <EmbedPanel dataset={dataset} />}
        {sub === "anomalies" && <AnomalyPanel dataset={dataset} />}
        {sub === "forecast" && <ForecastPanel dataset={dataset} />}
      </div>
    </div>
  );
}

// ---------- shared ----------

function FeaturePicker({ cols, value, onChange, exclude = [] }: { cols: ColumnInfo[]; value: string[]; onChange: (v: string[]) => void; exclude?: string[] }) {
  const options = cols.filter((c) => !exclude.includes(c.name));
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium">Features ({value.filter((v) => !exclude.includes(v)).length})</span>
        <span className="space-x-2 text-xs">
          <button className="text-accent" onClick={() => onChange(options.map((c) => c.name))}>All</button>
          <button className="text-accent" onClick={() => onChange([])}>None</button>
        </span>
      </div>
      <div className="flex max-h-40 flex-wrap gap-1 overflow-auto">
        {options.map((c) => {
          const on = value.includes(c.name);
          return (
            <button
              key={c.name}
              onClick={() => onChange(on ? value.filter((v) => v !== c.name) : [...value, c.name])}
              aria-pressed={on}
              className={`rounded-full border px-2 py-0.5 text-xs ${on ? "border-accent bg-accent-soft text-accent" : "text-muted hover:bg-surface-2"}`}
            >
              {c.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function useTask<T>() {
  const [state, setState] = useState<{ progress?: string; result?: T; error?: string } | null>(null);
  const run = async (fn: (p: (m: string) => void) => Promise<T>) => {
    setState({ progress: "Starting…" });
    try {
      const result = await fn((progress) => setState({ progress }));
      setState({ result });
      return result;
    } catch (e) {
      setState({ error: (e as Error).message });
    }
  };
  return { state, run };
}

function Status({ state, idle }: { state: { progress?: string; error?: string } | null; idle: string }) {
  if (!state) return <p className="py-10 text-center text-sm text-muted">{idle}</p>;
  if (state.progress)
    return (
      <p className="flex items-center justify-center gap-2 py-10 text-sm text-muted">
        <Loader2 className="h-4 w-4 animate-spin" /> {state.progress}
      </p>
    );
  if (state.error) return <p className="rounded-lg bg-bad-soft p-3 text-sm text-bad">{state.error}</p>;
  return null;
}

/** Vertical axis title, rotated beside the axis so it never collides with a legend. */
const Y_NAME = { nameLocation: "middle", nameRotate: 90, nameGap: 44 };

const baseOpt = (t: ThemeColors): EChartsOption => ({
  backgroundColor: "transparent",
  textStyle: { color: t.text, fontFamily: "inherit" },
  grid: { left: 8, right: 16, top: 24, bottom: 8, containLabel: true },
});
const ax = (t: ThemeColors, name = "", extra: object = {}) => ({
  name,
  nameLocation: "middle",
  nameGap: 28,
  nameTextStyle: { color: t.muted },
  axisLabel: { color: t.muted },
  axisLine: { lineStyle: { color: t.border } },
  splitLine: { lineStyle: { color: t.grid } },
  ...extra,
});

// ---------- AutoML ----------

function AutoMLPanel({ dataset }: { dataset: Dataset }) {
  const cols = dataset.columns;
  const [target, setTarget] = useState(() => cols.find((c) => /surviv|target|label|churn|class/i.test(c.name))?.name ?? cols[cols.length - 1]?.name ?? "");
  const [features, setFeatures] = useState(() => defaultFeatures(cols, [target]));
  const [task, setTask] = useState<"auto" | "classification" | "regression">("auto");
  const { state, run } = useTask<AutoMLResult>();

  return (
    <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <section className={`${card} space-y-4 self-start`}>
        <div>
          <h3 className="font-semibold">Predict a column</h3>
          <p className="text-sm text-muted">Trains five models with cross-validation and ranks them.</p>
        </div>
        <label className="block space-y-1">
          <span className="text-sm font-medium">Target (what to predict)</span>
          <select className={field} value={target} onChange={(e) => setTarget(e.target.value)}>
            {cols.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name} ({c.kind})
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium">Task</span>
          <select className={field} value={task} onChange={(e) => setTask(e.target.value as typeof task)}>
            <option value="auto">Detect automatically</option>
            <option value="classification">Classification (categories)</option>
            <option value="regression">Regression (numbers)</option>
          </select>
        </label>
        <FeaturePicker cols={cols} value={features} onChange={setFeatures} exclude={[target]} />
        <button
          disabled={!target || !features.filter((f) => f !== target).length || !!state?.progress}
          onClick={() => run((p) => trainAutoML(dataset, target, features.filter((f) => f !== target), task, p))}
          className="w-full rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-fg disabled:opacity-40"
        >
          Train models
        </button>
        <p className="text-xs text-muted">Missing values, encoding and scaling are handled automatically inside the pipeline. Large data is sampled to 20,000 rows.</p>
      </section>

      <div className="min-w-0 space-y-4">
        {state?.result ? <AutoMLResults dataset={dataset} r={state.result} /> : <div className={card}><Status state={state} idle="Pick a target and train. The first run downloads scikit-learn (cached afterwards)." /></div>}
      </div>
    </div>
  );
}

function AutoMLResults({ dataset, r }: { dataset: Dataset; r: AutoMLResult }) {
  const t = useThemeColors();
  const best = r.leaderboard[0];
  const metrics = r.task === "classification" ? ["roc_auc", "f1", "accuracy"].filter((m) => m in best) : ["r2", "rmse", "mae"];
  const totalImp = r.importance.reduce((s, i) => s + Math.max(0, i.value), 0) || 1;
  const top2 = r.importance.slice(0, 2);
  const share = top2.reduce((s, i) => s + Math.max(0, i.value), 0) / totalImp;
  const perfect = (r.task === "classification" ? best.accuracy : best.r2) >= 0.995;
  const [showCode, setShowCode] = useState(false);

  const headline =
    r.task === "classification"
      ? `${r.best} predicts ${r.target} correctly ${(best.accuracy * 100).toFixed(1)}% of the time, versus ${((r.baseline.accuracy ?? 0) * 100).toFixed(1)}% by ${r.baseline.name}.`
      : `${r.best} explains ${(best.r2 * 100).toFixed(1)}% of the variation in ${r.target} (typical error ${fmt(best.rmse)}, versus ${fmt(r.baseline.rmse ?? 0)} by ${r.baseline.name}).`;

  const importanceOpt = useMemo<EChartsOption>(() => {
    const items = r.importance.slice(0, 12).reverse();
    return {
      ...baseOpt(t),
      tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, valueFormatter: (v: number) => `${((Math.max(0, v) / totalImp) * 100).toFixed(1)}% of total` },
      xAxis: { type: "value", ...ax(t, "Drop in score when shuffled") },
      yAxis: { type: "category", data: items.map((i) => i.feature), axisLabel: { color: t.text }, axisLine: { lineStyle: { color: t.border } }, axisTick: { show: false } },
      series: [{ type: "bar", data: items.map((i) => Math.max(0, i.value)), itemStyle: { color: t.series[0], borderRadius: [0, 4, 4, 0] }, barMaxWidth: 22 }],
    };
  }, [r, t, totalImp]);

  return (
    <>
      <section className={card}>
        <div className="mb-3 flex items-start gap-2">
          <Trophy className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
          <p className="text-lg leading-snug" data-testid="ml-headline">{headline}</p>
        </div>
        {perfect && (
          <p className="mb-3 flex items-start gap-2 rounded-lg bg-warn-soft px-3 py-2 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
            Suspiciously perfect. A feature probably leaks the answer (top feature: {r.importance[0]?.feature}). Remove it and retrain.
          </p>
        )}
        <div className="overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted">
                <th className="py-1.5 pr-3 font-medium">Model</th>
                {metrics.map((m) => (
                  <th key={m} className="px-3 py-1.5 text-right font-medium">
                    {METRIC_LABELS[m]}
                    {m === r.primary && " ★"}
                  </th>
                ))}
                <th className="py-1.5 pl-3 text-right font-medium">Time</th>
              </tr>
            </thead>
            <tbody>
              {r.leaderboard.map((row, i) => (
                <tr key={row.model} className={`border-b last:border-0 ${i === 0 ? "bg-accent-soft/60 font-medium" : ""}`}>
                  <td className="py-1.5 pr-3">{row.model}</td>
                  {metrics.map((m) => (
                    <td key={m} className="px-3 py-1.5 text-right font-mono tabular-nums">
                      {row[m].toFixed(3)} <span className="text-xs text-muted">± {row[`${m}_std`].toFixed(3)}</span>
                    </td>
                  ))}
                  <td className="py-1.5 pl-3 text-right tabular-nums text-muted">{row.seconds.toFixed(1)}s</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-muted">
          {r.folds}-fold cross-validation <InfoTip concept="cv" /> on {r.rows.toLocaleString()} rows. ★ = ranking metric{r.primary === "roc_auc" && <> (ROC AUC <InfoTip concept="auc" />)</>}. ± is the spread across folds.
        </p>
      </section>

      <div className="grid gap-4 xl:grid-cols-2">
        <section className={card}>
          <h3 className="flex items-center gap-1.5 font-semibold">
            What drives the predictions <InfoTip concept="importance" />
          </h3>
          <p className="mb-2 text-sm text-muted">
            {top2.map((i) => i.feature).join(" and ")} drive {(share * 100).toFixed(0)}% of the model&apos;s predictive power (permutation importance).
          </p>
          <EChart option={importanceOpt} style={{ height: Math.max(200, Math.min(12, r.importance.length) * 28 + 60) }} />
        </section>
        <EvaluationChart r={r} t={t} />
      </div>

      <WhatIf r={r} />

      <section className={`${card} flex flex-wrap items-center gap-3`}>
        <BatchPredict r={r} />
        <button onClick={() => setShowCode((v) => !v)} className="ml-auto inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm hover:bg-surface-2">
          <Code2 className="h-4 w-4" /> {showCode ? "Hide" : "Show"} scikit-learn code
        </button>
        {showCode && (
          <pre className="w-full overflow-auto rounded-lg bg-surface-2 p-3 font-mono text-xs">
            <code>{pipelineCode(dataset, r)}</code>
          </pre>
        )}
      </section>
    </>
  );
}

function EvaluationChart({ r, t }: { r: AutoMLResult; t: ThemeColors }) {
  const option = useMemo<EChartsOption | null>(() => {
    if (r.roc) {
      return {
        ...baseOpt(t),
        tooltip: { trigger: "axis", valueFormatter: (v: number) => v.toFixed(3) },
        xAxis: { type: "value", min: 0, max: 1, ...ax(t, "False positive rate") },
        yAxis: { type: "value", min: 0, max: 1, ...ax(t, "True positive rate", Y_NAME) },
        series: [
          { type: "line", name: "ROC", data: r.roc.fpr.map((x, i) => [x, r.roc!.tpr[i]]), showSymbol: false, lineStyle: { width: 2, color: t.series[0] }, areaStyle: { color: t.series[0], opacity: 0.08 } },
          { type: "line", name: "Chance", data: [[0, 0], [1, 1]], showSymbol: false, lineStyle: { type: "dashed", color: t.muted, width: 1 } },
        ],
      };
    }
    if (r.confusion) {
      const { labels, matrix } = r.confusion;
      const max = Math.max(...matrix.flat(), 1);
      return {
        ...baseOpt(t),
        tooltip: { formatter: (p: { value: number[] }) => `Actual ${labels[p.value[1]]}, predicted ${labels[p.value[0]]}: <b>${p.value[2]}</b>` },
        xAxis: { type: "category", data: labels, ...ax(t, "Predicted"), splitLine: { show: false } },
        yAxis: { type: "category", data: labels, inverse: true, ...ax(t, "Actual", Y_NAME), splitLine: { show: false } },
        visualMap: { show: false, min: 0, max, inRange: { color: ["#cde2fb", "#3987e5", "#0d366b"] } },
        series: [{ type: "heatmap", data: matrix.flatMap((row, i) => row.map((v, j) => ({ value: [j, i, v], label: { color: v > max / 2 ? "#fff" : "#0b0b0b" } }))), label: { show: labels.length <= 8 }, itemStyle: { borderColor: t.surface, borderWidth: 2 } }],
      };
    }
    if (r.residuals) {
      const { actual, predicted } = r.residuals;
      const lo = Math.min(...actual, ...predicted);
      const hi = Math.max(...actual, ...predicted);
      return {
        ...baseOpt(t),
        tooltip: { trigger: "item", formatter: (p: { value: number[] }) => `actual ${fmt(p.value[0])}<br/>predicted ${fmt(p.value[1])}` },
        xAxis: { type: "value", scale: true, ...ax(t, `Actual ${r.target}`) },
        yAxis: { type: "value", scale: true, ...ax(t, "Predicted", Y_NAME) },
        series: [
          { type: "scatter", data: actual.map((a, i) => [a, predicted[i]]), symbolSize: 6, itemStyle: { color: t.series[0], opacity: 0.6 } },
          { type: "line", data: [[lo, lo], [hi, hi]], showSymbol: false, lineStyle: { type: "dashed", color: t.muted, width: 1 }, tooltip: { show: false } },
        ],
      };
    }
    return null;
  }, [r, t]);

  const title = r.roc ? `ROC curve (AUC ${r.roc.auc.toFixed(3)}, positive class "${r.roc.positive}")` : r.confusion ? "Confusion matrix" : "Predicted vs actual";
  const note = r.roc
    ? "The further the curve bows towards the top-left, the better. The dashed line is guessing."
    : r.confusion
      ? "Rows are the truth, columns the prediction. The diagonal holds the correct predictions."
      : "Points on the dashed line are perfect predictions; the vertical gap is the error (residual).";
  return (
    <section className={card}>
      <h3 className="font-semibold">{title}</h3>
      <p className="mb-2 text-sm text-muted">{note} Out-of-fold predictions, so this is an honest estimate.</p>
      {option && <EChart option={option} className="h-72 w-full" />}
    </section>
  );
}

function WhatIf({ r }: { r: AutoMLResult }) {
  const [values, setValues] = useState<Record<string, string | number>>(() => Object.fromEntries(r.inputs.map((i) => [i.name, i.default])));
  const [out, setOut] = useState<{ prediction: string | number; probabilities?: Record<string, number> } | null>(null);
  const seq = useRef(0);

  // Debounced live prediction as inputs change.
  useEffect(() => {
    const id = ++seq.current;
    const timer = setTimeout(async () => {
      const res = await predictRows(r.modelId, [values]);
      if (id === seq.current) setOut({ prediction: res.prediction[0], probabilities: res.probabilities?.[0] });
    }, 200);
    return () => clearTimeout(timer);
  }, [values, r.modelId]);

  const inputs = [...r.inputs].sort((a, b) => r.importance.findIndex((i) => i.feature === a.name) - r.importance.findIndex((i) => i.feature === b.name)).slice(0, 10);

  return (
    <section className={card}>
      <h3 className="flex items-center gap-2 font-semibold">
        <Sparkles className="h-4 w-4 text-accent" /> What-if
      </h3>
      <p className="mb-3 text-sm text-muted">Change the inputs (most important first) and watch the prediction update.</p>
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_16rem]">
        <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          {inputs.map((i) => (
            <label key={i.name} className="block space-y-1 text-sm">
              <span className="flex justify-between">
                <span className="font-medium">{i.name}</span>
                {i.type === "number" && <span className="font-mono tabular-nums text-muted">{fmt(Number(values[i.name]))}</span>}
              </span>
              {i.type === "number" ? (
                <input
                  type="range"
                  min={i.min}
                  max={i.max === i.min ? i.min + 1 : i.max}
                  step={i.integer ? 1 : (i.max - i.min) / 100 || 0.01}
                  value={Number(values[i.name])}
                  onChange={(e) => setValues((v) => ({ ...v, [i.name]: Number(e.target.value) }))}
                  className="w-full accent-[var(--accent)]"
                  aria-label={i.name}
                />
              ) : (
                <select className={field} value={String(values[i.name])} onChange={(e) => setValues((v) => ({ ...v, [i.name]: e.target.value }))} aria-label={i.name}>
                  {i.options.map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </select>
              )}
            </label>
          ))}
        </div>
        <div className="rounded-xl bg-accent-soft p-4" data-testid="whatif">
          <div className="text-xs uppercase tracking-wide text-muted">Predicted {r.target}</div>
          <div className="mt-1 text-3xl font-semibold text-accent">{out ? (typeof out.prediction === "number" ? fmt(out.prediction) : out.prediction) : "…"}</div>
          {out?.probabilities && (
            <ul className="mt-3 space-y-1.5">
              {Object.entries(out.probabilities)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5)
                .map(([k, p]) => (
                  <li key={k} className="text-xs">
                    <div className="flex justify-between">
                      <span>{k}</span>
                      <span className="tabular-nums">{(p * 100).toFixed(1)}%</span>
                    </div>
                    <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-surface">
                      <div className="h-full rounded-full bg-accent" style={{ width: `${p * 100}%` }} />
                    </div>
                  </li>
                ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

function BatchPredict({ r }: { r: AutoMLResult }) {
  const datasets = useStudio((s) => s.datasets);
  const [id, setId] = useState(datasets[0]?.id ?? "");
  const { state, run } = useTask<{ csv: string; rows: number }>();
  const ds = datasets.find((d) => d.id === id);
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="font-medium">Predict for</span>
      <select className="rounded-lg border bg-surface px-2 py-1.5" value={id} onChange={(e) => setId(e.target.value)} aria-label="Dataset to predict">
        {datasets.map((d) => (
          <option key={d.id} value={d.id}>
            {d.name}
          </option>
        ))}
      </select>
      <button
        disabled={!ds || !!state?.progress}
        onClick={async () => {
          const res = await run((p) => predictDataset(r.modelId, ds!, p));
          if (res) download(res.csv, `${ds!.table}_predictions.csv`, "text/csv");
        }}
        className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 font-medium text-accent-fg disabled:opacity-40"
      >
        {state?.progress ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />} Download predictions
      </button>
      {state?.error && <span className="text-bad">{state.error}</span>}
      {state?.result && <span className="text-good">{state.result.rows.toLocaleString()} rows predicted.</span>}
      <span className="w-full text-xs text-muted">Add new data with + in the sidebar; it needs the same feature columns.</span>
    </div>
  );
}

// ---------- Clusters ----------

function ClustersPanel({ dataset }: { dataset: Dataset }) {
  const t = useThemeColors();
  const numeric = dataset.columns.filter((c) => c.kind === "number");
  const [features, setFeatures] = useState(() => defaultFeatures(numeric, []));
  const [method, setMethod] = useState<"kmeans" | "dbscan">("kmeans");
  const [k, setK] = useState<number | "">("");
  const [eps, setEps] = useState(0.8);
  const { state, run } = useTask<ClusterResult>();
  const r = state?.result;

  const scatter = useMemo<EChartsOption | null>(() => {
    if (!r) return null;
    const ids = [...new Set(r.points.map((p) => p.c))].sort((a, b) => a - b);
    return {
      ...baseOpt(t),
      legend: { top: 0, textStyle: { color: t.text } },
      grid: { left: 8, right: 16, top: 40, bottom: 8, containLabel: true },
      tooltip: { trigger: "item" },
      xAxis: { type: "value", scale: true, ...ax(t, "PC 1") },
      yAxis: { type: "value", scale: true, ...ax(t, "PC 2", Y_NAME) },
      series: ids.map((c, i) => ({
        type: "scatter",
        name: c === -1 ? "Noise" : `Cluster ${c + 1}`,
        data: r.points.filter((p) => p.c === c).map((p) => [p.x, p.y]),
        symbolSize: 6,
        itemStyle: { color: c === -1 ? t.other : t.series[i % 8], opacity: 0.7, borderColor: t.surface, borderWidth: 0.5 },
      })),
    };
  }, [r, t]);

  // Two single-axis charts (never one dual-axis chart): inertia for the elbow, silhouette for quality.
  const elbow = useMemo<[EChartsOption, EChartsOption] | null>(() => {
    if (!r?.elbow) return null;
    const one = (name: string, values: number[], color: string): EChartsOption => ({
      ...baseOpt(t),
      grid: { left: 8, right: 8, top: 12, bottom: 8, containLabel: true },
      tooltip: { trigger: "axis", valueFormatter: (v: number) => fmt(v) },
      xAxis: { type: "category", data: r.elbow!.map((e) => String(e.k)), ...ax(t, "k") },
      yAxis: { type: "value", scale: true, ...ax(t, name, Y_NAME) },
      series: [{ type: "line", data: values, lineStyle: { width: 2, color }, itemStyle: { color }, symbolSize: 8,
        markPoint: undefined }],
    });
    return [
      one("Inertia", r.elbow.map((e) => e.inertia), t.series[0]),
      one("Silhouette", r.elbow.map((e) => e.silhouette), t.series[0]),
    ];
  }, [r, t]);

  return (
    <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <section className={`${card} space-y-4 self-start`}>
        <div>
          <h3 className="font-semibold">Find natural groups</h3>
          <p className="text-sm text-muted">Clustering groups similar rows without a target column.</p>
        </div>
        <FeaturePicker cols={dataset.columns.filter((c) => c.kind !== "text")} value={features} onChange={setFeatures} />
        <select className={field} value={method} onChange={(e) => setMethod(e.target.value as typeof method)} aria-label="Method">
          <option value="kmeans">K-Means</option>
          <option value="dbscan">DBSCAN (density-based)</option>
        </select>
        {method === "kmeans" ? (
          <label className="block space-y-1 text-sm">
            <span className="font-medium">Number of clusters</span>
            <input className={field} type="number" min={2} max={10} placeholder="Auto (best silhouette)" value={k} onChange={(e) => setK(e.target.value ? Number(e.target.value) : "")} />
          </label>
        ) : (
          <label className="block space-y-1 text-sm">
            <span className="font-medium">Neighbourhood size (eps)</span>
            <input className={field} type="number" step={0.1} min={0.1} value={eps} onChange={(e) => setEps(Number(e.target.value))} />
          </label>
        )}
        <button
          disabled={features.length < 2 || !!state?.progress}
          onClick={() => run((p) => runClusters(dataset, features, method === "kmeans" ? { method, k: k || undefined } : { method, eps, min_samples: 8 }, p))}
          className="w-full rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-fg disabled:opacity-40"
        >
          Find clusters
        </button>
      </section>
      <div className="min-w-0 space-y-4">
        {!r ? (
          <div className={card}>
            <Status state={state} idle="Pick at least two features and find clusters." />
          </div>
        ) : (
          <>
            <section className={card}>
              <h3 className="font-semibold" data-testid="cluster-headline">
                {r.k} clusters{r.silhouette != null && ` (silhouette ${r.silhouette.toFixed(2)})`} <InfoTip concept="silhouette" />
                {r.noise ? `, ${r.noise.toLocaleString()} noise points` : ""}
              </h3>
              <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {r.profiles
                  .filter((p) => p.cluster !== -1)
                  .map((p, i) => (
                    <div key={p.cluster} className="rounded-lg border p-3 text-sm">
                      <div className="mb-1 flex items-center justify-between">
                        <span className="flex items-center gap-2 font-medium">
                          <span className="h-3 w-3 rounded-full" style={{ background: t.series[i % 8] }} /> Cluster {p.cluster + 1}
                        </span>
                        <span className="text-xs text-muted">{p.size.toLocaleString()} rows</span>
                      </div>
                      <p>{describeCluster(p)}</p>
                    </div>
                  ))}
              </div>
            </section>
            <div className="grid gap-4 xl:grid-cols-2">
              <section className={card}>
                <h3 className="font-semibold">Clusters on the first two principal components</h3>
                {scatter && <EChart option={scatter} className="h-80 w-full" />}
              </section>
              {elbow && (
                <section className={card}>
                  <h3 className="font-semibold">Choosing k</h3>
                  <p className="text-sm text-muted">Look for the elbow in inertia, or the peak silhouette. Chosen: k = {r.k}.</p>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <div className="text-xs font-medium text-muted">Inertia (look for the elbow)</div>
                      <EChart option={elbow[0]} className="h-56 w-full" />
                    </div>
                    <div>
                      <div className="text-xs font-medium text-muted">Silhouette (higher is better)</div>
                      <EChart option={elbow[1]} className="h-56 w-full" />
                    </div>
                  </div>
                </section>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function describeCluster(p: ClusterResult["profiles"][number]) {
  const parts = p.traits.map((tr) => `${Math.abs(tr.z) >= 1 ? "much " : ""}${tr.z > 0 ? "higher" : "lower"} ${tr.feature} (avg ${fmt(tr.mean)})`);
  const cats = p.categories.map((c) => `mostly ${c.feature} = ${c.value} (${(c.share * 100).toFixed(0)}% vs ${(c.overall * 100).toFixed(0)}% overall)`);
  const all = [...parts, ...cats];
  return all.length ? `${all.join(", ")}.` : "Close to the overall average on every feature.";
}

// ---------- PCA / t-SNE ----------

function EmbedPanel({ dataset }: { dataset: Dataset }) {
  const t = useThemeColors();
  const numeric = dataset.columns.filter((c) => c.kind === "number");
  const [features, setFeatures] = useState(() => defaultFeatures(numeric, []));
  const [method, setMethod] = useState<"pca" | "tsne">("pca");
  const [color, setColor] = useState(() => dataset.columns.find((c) => c.kind === "category")?.name ?? "");
  const { state, run } = useTask<EmbedResult>();
  const r = state?.result;

  const option = useMemo<EChartsOption | null>(() => {
    if (!r) return null;
    const groups = [...new Set(r.points.map((p) => p.g))];
    const top = groups.length > 8 ? null : groups;
    return {
      ...baseOpt(t),
      legend: top && top[0] !== null ? { top: 0, textStyle: { color: t.text } } : undefined,
      grid: { left: 8, right: 16, top: 40, bottom: 8, containLabel: true },
      tooltip: { trigger: "item" },
      xAxis: { type: "value", scale: true, ...ax(t, method === "pca" ? `PC 1 (${((r.explained?.[0] ?? 0) * 100).toFixed(0)}%)` : "t-SNE 1") },
      yAxis: { type: "value", scale: true, ...ax(t, method === "pca" ? `PC 2 (${((r.explained?.[1] ?? 0) * 100).toFixed(0)}%)` : "t-SNE 2", Y_NAME) },
      series: (top ?? [null]).map((g, i) => ({
        type: "scatter",
        name: g ?? "rows",
        data: r.points.filter((p) => top === null || p.g === g).map((p) => [p.x, p.y]),
        symbolSize: 6,
        itemStyle: { color: t.series[i % 8], opacity: 0.7 },
      })),
    };
  }, [r, t, method]);

  const variance = useMemo<EChartsOption | null>(() => {
    if (!r?.explained) return null;
    let cum = 0;
    return {
      ...baseOpt(t),
      tooltip: { trigger: "axis", valueFormatter: (v: number) => `${(v * 100).toFixed(1)}%` },
      xAxis: { type: "category", data: r.explained.map((_, i) => `PC${i + 1}`), ...ax(t, "") },
      yAxis: { type: "value", max: 1, ...ax(t, ""), axisLabel: { color: t.muted, formatter: (v: number) => `${v * 100}%` } },
      series: [
        { type: "bar", name: "Explained", data: r.explained, itemStyle: { color: t.series[0], borderRadius: [4, 4, 0, 0] } },
        { type: "line", name: "Cumulative", data: r.explained.map((v) => (cum += v)), lineStyle: { color: t.series[1], width: 2 }, itemStyle: { color: t.series[1] } },
      ],
    };
  }, [r, t]);

  return (
    <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <section className={`${card} space-y-4 self-start`}>
        <div>
          <h3 className="font-semibold">Map high-dimensional data in 2D</h3>
          <p className="text-sm text-muted">PCA keeps the directions of greatest variance; t-SNE keeps neighbours close (slower).</p>
        </div>
        <FeaturePicker cols={dataset.columns.filter((c) => c.kind !== "text")} value={features} onChange={setFeatures} />
        <select className={field} value={method} onChange={(e) => setMethod(e.target.value as typeof method)} aria-label="Method">
          <option value="pca">PCA</option>
          <option value="tsne">t-SNE (samples 1,500 rows)</option>
        </select>
        <label className="block space-y-1 text-sm">
          <span className="font-medium">Colour points by</span>
          <select className={field} value={color} onChange={(e) => setColor(e.target.value)}>
            <option value="">Nothing</option>
            {dataset.columns.filter((c) => c.kind === "category" || c.kind === "boolean").map((c) => (
              <option key={c.name}>{c.name}</option>
            ))}
          </select>
        </label>
        <button
          disabled={features.length < 2 || !!state?.progress}
          onClick={() => run((p) => runEmbedding(dataset, features, method, color || undefined, p))}
          className="w-full rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-fg disabled:opacity-40"
        >
          Run {method === "pca" ? "PCA" : "t-SNE"}
        </button>
      </section>
      <div className="min-w-0 space-y-4">
        {!r ? (
          <div className={card}>
            <Status state={state} idle="Pick at least two features." />
          </div>
        ) : (
          <div className="grid gap-4 xl:grid-cols-2">
            <section className={card}>
              <h3 className="font-semibold" data-testid="embed-headline">
                {method === "pca" ? `PCA: the first two components keep ${(((r.explained?.[0] ?? 0) + (r.explained?.[1] ?? 0)) * 100).toFixed(0)}% of the variance` : "t-SNE map"}
              </h3>
              {r.sampled && <p className="text-xs text-muted">Showing a random sample of rows.</p>}
              {option && <EChart option={option} className="h-80 w-full" />}
            </section>
            {variance && (
              <section className={card}>
                <h3 className="font-semibold">Explained variance</h3>
                <EChart option={variance} className="h-80 w-full" />
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- Anomalies ----------

function AnomalyPanel({ dataset }: { dataset: Dataset }) {
  const t = useThemeColors();
  const numeric = dataset.columns.filter((c) => c.kind === "number");
  const [features, setFeatures] = useState(() => defaultFeatures(numeric, []));
  const [contamination, setContamination] = useState(0.02);
  const { state, run } = useTask<AnomalyResult>();
  const r = state?.result;
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);

  // Fetch the full flagged rows from DuckDB so they can be inspected in context.
  useEffect(() => {
    if (!r?.top.length) return;
    const ids = r.top.slice(0, 50).map((x) => x.row);
    query(`SELECT rowid AS __row, * FROM ${ident(dataset.table)} WHERE rowid IN (${ids.join(",")})`).then((data) => {
      const byId = new Map(data.map((d) => [d.__row as number, d]));
      setRows(ids.map((id) => byId.get(id)).filter(Boolean) as Record<string, unknown>[]);
    });
  }, [r, dataset.table]);

  const option = useMemo<EChartsOption | null>(() => {
    if (!r) return null;
    return {
      ...baseOpt(t),
      legend: { top: 0, textStyle: { color: t.text } },
      grid: { left: 8, right: 16, top: 40, bottom: 8, containLabel: true },
      tooltip: { trigger: "item" },
      xAxis: { type: "value", scale: true, ...ax(t, "PC 1") },
      yAxis: { type: "value", scale: true, ...ax(t, "PC 2", Y_NAME) },
      series: [
        { type: "scatter", name: "Normal", data: r.points.filter((p) => !p.a).map((p) => [p.x, p.y]), symbolSize: 5, itemStyle: { color: t.other, opacity: 0.4 } },
        { type: "scatter", name: "Anomaly", data: r.points.filter((p) => p.a).map((p) => [p.x, p.y]), symbolSize: 9, itemStyle: { color: t.series[7], borderColor: t.surface, borderWidth: 1 } },
      ],
    };
  }, [r, t]);

  const cols = dataset.columns.slice(0, 8);
  const why = new Map(r?.top.map((x) => [x.row, x]) ?? []);

  return (
    <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <section className={`${card} space-y-4 self-start`}>
        <div>
          <h3 className="font-semibold">Find unusual rows</h3>
          <p className="text-sm text-muted">Isolation Forest flags rows that are easy to separate from the rest.</p>
        </div>
        <FeaturePicker cols={dataset.columns.filter((c) => c.kind !== "text")} value={features} onChange={setFeatures} />
        <label className="block space-y-1 text-sm">
          <span className="flex justify-between font-medium">
            Expected share of anomalies <span className="tabular-nums text-muted">{(contamination * 100).toFixed(1)}%</span>
          </span>
          <input type="range" min={0.005} max={0.1} step={0.005} value={contamination} onChange={(e) => setContamination(Number(e.target.value))} className="w-full accent-[var(--accent)]" />
        </label>
        <button
          disabled={!features.length || !!state?.progress}
          onClick={() => run((p) => runAnomalies(dataset, features, contamination, p))}
          className="w-full rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-fg disabled:opacity-40"
        >
          Detect anomalies
        </button>
      </section>
      <div className="min-w-0 space-y-4">
        {!r ? (
          <div className={card}>
            <Status state={state} idle="Pick features and detect anomalies." />
          </div>
        ) : (
          <>
            <section className={card}>
              <h3 className="font-semibold" data-testid="anomaly-headline">
                {r.flagged.toLocaleString()} of {r.rows.toLocaleString()} rows flagged as unusual
              </h3>
              {option && <EChart option={option} className="h-72 w-full" />}
            </section>
            <section className={`${card} overflow-auto`}>
              <h3 className="mb-2 font-semibold">Most unusual rows</h3>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted">
                    <th className="py-1.5 pr-3 font-medium">Row</th>
                    <th className="py-1.5 pr-3 font-medium">Why</th>
                    {cols.map((c) => (
                      <th key={c.name} className="px-2 py-1.5 font-medium">{c.name}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const info = why.get(row.__row as number);
                    return (
                      <tr key={String(row.__row)} className="border-b bg-bad-soft/40 last:border-0">
                        <td className="py-1.5 pr-3 font-mono text-xs">{(row.__row as number) + 1}</td>
                        <td className="py-1.5 pr-3 text-xs">{info?.why}</td>
                        {cols.map((c) => (
                          <td key={c.name} className="whitespace-nowrap px-2 py-1.5 font-mono text-xs">{formatCell(row[c.name])}</td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function formatCell(v: unknown) {
  if (v === null || v === undefined) return "–";
  if (typeof v === "number") return fmt(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}
