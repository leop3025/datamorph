"use client";

import { useMemo, useState } from "react";
import { Loader2, TrendingUp } from "lucide-react";
import type { Dataset } from "@/lib/data/types";
import { callPython, frameFile } from "@/lib/python/client";
import { fmt } from "@/lib/charts/builder";
import { EChart, useThemeColors, type ThemeColors } from "@/components/charts/EChart";
import type { EChartsOption } from "@/lib/charts/echarts";

interface TSResult {
  index: string[];
  values: number[];
  rolling: number[];
  season_length: number | null;
  seasonal_strength?: number;
  decomposition?: { trend: (number | null)[]; seasonal: number[]; resid: (number | null)[] };
  forecast: { index: string[]; mean: number[]; lower: number[]; upper: number[] };
  mape: number | null;
  model: string;
}

const FREQS = [
  { value: "D", label: "Daily" },
  { value: "W", label: "Weekly" },
  { value: "MS", label: "Monthly" },
  { value: "QS", label: "Quarterly" },
];

const field = "w-full rounded-lg border bg-surface px-2.5 py-1.5 text-sm outline-none focus:border-accent";

export function ForecastPanel({ dataset }: { dataset: Dataset }) {
  const t = useThemeColors();
  const dates = dataset.columns.filter((c) => c.kind === "date");
  const nums = dataset.columns.filter((c) => c.kind === "number" && !/(^|_)id$/i.test(c.name));
  const [date, setDate] = useState(dates[0]?.name ?? "");
  const [value, setValue] = useState(nums[0]?.name ?? "");
  const [freq, setFreq] = useState("MS");
  const [agg, setAgg] = useState<"sum" | "mean">("sum");
  const [window, setWindow] = useState(3);
  const [horizon, setHorizon] = useState(6);
  const [state, setState] = useState<{ progress?: string; result?: TSResult; error?: string } | null>(null);

  const run = async () => {
    setState({ progress: "Preparing data…" });
    try {
      const path = `/data/${dataset.table}_v${dataset.version}_ts.csv`;
      const { file, dates: dcols } = await frameFile(dataset, [date, value], path, 2_000_000);
      const result = await callPython<TSResult>(
        "timeseries",
        { path, dates: dcols, fresh: true, date, value, freq, agg, window, horizon },
        { packages: ["scipy", "statsmodels"], sections: ["ts"], files: [file], onProgress: (progress) => setState({ progress }) },
      );
      setState({ result });
    } catch (e) {
      setState({ error: (e as Error).message });
    }
  };

  const r = state?.result;
  const main = useMemo(() => (r ? forecastChart(r, t, value, window) : null), [r, t, value, window]);
  const decomp = useMemo(() => (r?.decomposition ? decompositionCharts(r, t) : null), [r, t]);

  if (!dates.length)
    return <p className="rounded-xl border bg-surface p-6 text-sm text-muted">This dataset has no date column. Convert a column to a date in Clean → Change column type first.</p>;

  return (
    <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <section className="space-y-3 self-start rounded-xl border bg-surface p-4">
        <div>
          <h3 className="flex items-center gap-2 font-semibold">
            <TrendingUp className="h-4 w-4 text-accent" /> Time series & forecast
          </h3>
          <p className="text-sm text-muted">Resample, smooth, decompose into trend + seasonality, and forecast with confidence bands.</p>
        </div>
        <label className="block space-y-1 text-sm">
          <span className="font-medium">Date</span>
          <select className={field} value={date} onChange={(e) => setDate(e.target.value)}>
            {dates.map((c) => <option key={c.name}>{c.name}</option>)}
          </select>
        </label>
        <label className="block space-y-1 text-sm">
          <span className="font-medium">Value</span>
          <select className={field} value={value} onChange={(e) => setValue(e.target.value)}>
            {nums.map((c) => <option key={c.name}>{c.name}</option>)}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block space-y-1 text-sm">
            <span className="font-medium">Resample</span>
            <select className={field} value={freq} onChange={(e) => setFreq(e.target.value)}>
              {FREQS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
          </label>
          <label className="block space-y-1 text-sm">
            <span className="font-medium">Combine by</span>
            <select className={field} value={agg} onChange={(e) => setAgg(e.target.value as "sum" | "mean")}>
              <option value="sum">Sum</option>
              <option value="mean">Average</option>
            </select>
          </label>
          <label className="block space-y-1 text-sm">
            <span className="font-medium">Rolling window</span>
            <input className={field} type="number" min={2} max={60} value={window} onChange={(e) => setWindow(Math.max(2, Number(e.target.value) || 2))} />
          </label>
          <label className="block space-y-1 text-sm">
            <span className="font-medium">Forecast periods</span>
            <input className={field} type="number" min={1} max={104} value={horizon} onChange={(e) => setHorizon(Math.max(1, Number(e.target.value) || 1))} />
          </label>
        </div>
        <button onClick={run} disabled={!date || !value || !!state?.progress} className="w-full rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-fg disabled:opacity-40">
          Analyse & forecast
        </button>
      </section>

      <div className="min-w-0 space-y-4">
        {!r ? (
          <div className="rounded-xl border bg-surface p-4">
            {state?.progress ? (
              <p className="flex items-center justify-center gap-2 py-10 text-sm text-muted"><Loader2 className="h-4 w-4 animate-spin" /> {state.progress}</p>
            ) : state?.error ? (
              <p className="rounded-lg bg-bad-soft p-3 text-sm text-bad">{state.error}</p>
            ) : (
              <p className="py-10 text-center text-sm text-muted">Pick a date and a value. The first run installs statsmodels.</p>
            )}
          </div>
        ) : (
          <>
            <section className="rounded-xl border bg-surface p-4">
              <h3 className="font-semibold" data-testid="forecast-headline">
                Next {r.forecast.index.length} periods: {fmt(r.forecast.mean[0])} → {fmt(r.forecast.mean[r.forecast.mean.length - 1])}
              </h3>
              <p className="text-sm text-muted">
                {r.model}.{" "}
                {r.mape != null && `On the most recent held-out periods it was off by ${(r.mape * 100).toFixed(1)}% on average (MAPE). `}
                {r.seasonal_strength != null && `Seasonality (period ${r.season_length}) explains about ${(r.seasonal_strength * 100).toFixed(0)}% of the non-trend variation.`}
                {r.season_length == null && "Not enough history for a seasonal model; the forecast follows the trend only."}
              </p>
              {main && <EChart option={main} className="mt-2 h-80 w-full" />}
            </section>
            {decomp && (
              <section className="rounded-xl border bg-surface p-4">
                <h3 className="font-semibold">Decomposition</h3>
                <p className="mb-2 text-sm text-muted">The series = trend + repeating seasonal pattern + what&apos;s left over (residual).</p>
                <div className="grid gap-2 md:grid-cols-3">
                  {decomp.map(([title, option]) => (
                    <div key={title}>
                      <div className="text-xs font-medium text-muted">{title}</div>
                      <EChart option={option} className="h-44 w-full" />
                    </div>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function forecastChart(r: TSResult, t: ThemeColors, value: string, window: number): EChartsOption {
  const x = [...r.index, ...r.forecast.index];
  const pad = (n: number) => new Array(n).fill(null);
  const last = r.values[r.values.length - 1];
  const n = r.index.length;
  // Forecast line starts at the last actual point so the two lines connect.
  const mean = [...pad(n - 1), last, ...r.forecast.mean];
  const lower = [...pad(n), ...r.forecast.lower];
  const band = [...pad(n), ...r.forecast.upper.map((u, i) => u - r.forecast.lower[i])];
  return {
    backgroundColor: "transparent",
    textStyle: { color: t.text, fontFamily: "inherit" },
    legend: { top: 0, textStyle: { color: t.text }, data: [value, `${window}-period average`, "Forecast", "95% interval"] },
    grid: { left: 8, right: 16, top: 40, bottom: 8, containLabel: true },
    tooltip: { trigger: "axis", valueFormatter: (v: number) => fmt(v) },
    xAxis: { type: "category", data: x, axisLabel: { color: t.muted, hideOverlap: true }, axisLine: { lineStyle: { color: t.border } } },
    yAxis: { type: "value", scale: true, axisLabel: { color: t.muted }, splitLine: { lineStyle: { color: t.grid } } },
    series: [
      { type: "line", name: "lower", data: lower, stack: "band", lineStyle: { opacity: 0 }, showSymbol: false, tooltip: { show: false } },
      { type: "line", name: "95% interval", data: band, stack: "band", lineStyle: { opacity: 0 }, showSymbol: false, areaStyle: { color: t.series[1], opacity: 0.15 }, itemStyle: { color: t.series[1] }, tooltip: { show: false } },
      { type: "line", name: value, data: [...r.values, ...pad(r.forecast.index.length)], showSymbol: false, lineStyle: { width: 2, color: t.series[0] }, itemStyle: { color: t.series[0] } },
      { type: "line", name: `${window}-period average`, data: [...r.rolling, ...pad(r.forecast.index.length)], showSymbol: false, lineStyle: { width: 1.5, type: "dashed", color: t.muted }, itemStyle: { color: t.muted } },
      { type: "line", name: "Forecast", data: mean, showSymbol: false, lineStyle: { width: 2, color: t.series[1] }, itemStyle: { color: t.series[1] } },
    ],
  };
}

function decompositionCharts(r: TSResult, t: ThemeColors): [string, EChartsOption][] {
  const mk = (data: (number | null)[], color: string): EChartsOption => ({
    backgroundColor: "transparent",
    grid: { left: 4, right: 8, top: 8, bottom: 4, containLabel: true },
    tooltip: { trigger: "axis", valueFormatter: (v: number) => fmt(v) },
    xAxis: { type: "category", data: r.index, axisLabel: { color: t.muted, hideOverlap: true, fontSize: 10 }, axisLine: { lineStyle: { color: t.border } } },
    yAxis: { type: "value", scale: true, axisLabel: { color: t.muted, fontSize: 10 }, splitLine: { lineStyle: { color: t.grid } } },
    series: [{ type: "line", data, showSymbol: false, lineStyle: { width: 1.5, color }, itemStyle: { color } }],
  });
  const d = r.decomposition!;
  return [
    ["Trend", mk(d.trend, t.series[0])],
    ["Seasonal", mk(d.seasonal, t.series[0])],
    ["Residual", mk(d.resid, t.series[0])],
  ];
}
