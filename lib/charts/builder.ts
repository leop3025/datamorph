"use client";

import { ident, query } from "@/lib/duckdb/client";
import type { ColumnInfo, ColumnKind, Dataset } from "@/lib/data/types";
import type { ThemeColors } from "@/components/charts/EChart";
import type { EChartsOption } from "./echarts";

export type ChartType = "bar" | "line" | "area" | "scatter" | "histogram" | "box" | "heatmap" | "pie" | "treemap";
export type Shelf = "x" | "y" | "color" | "size";
export type AggFn = "count" | "sum" | "mean" | "median" | "min" | "max";
export type Grain = "auto" | "day" | "week" | "month" | "quarter" | "year";

export interface ChartSpec {
  type: ChartType;
  x?: string;
  y?: string;
  color?: string;
  size?: string;
  agg: AggFn;
  grain: Grain;
  stack: boolean;
  topN: number;
}

export const DEFAULT_SPEC: ChartSpec = { type: "bar", agg: "sum", grain: "auto", stack: false, topN: 25 };

export const CHART_TYPES: { type: ChartType; label: string; hint: string }[] = [
  { type: "bar", label: "Bar", hint: "Compare a number across categories" },
  { type: "line", label: "Line", hint: "Trend over time or an ordered axis" },
  { type: "area", label: "Area", hint: "Trend with volume; stack to show composition" },
  { type: "scatter", label: "Scatter", hint: "Relationship between two numbers" },
  { type: "histogram", label: "Histogram", hint: "Distribution of one number" },
  { type: "box", label: "Box plot", hint: "Distribution of a number per group" },
  { type: "heatmap", label: "Heatmap", hint: "A value across two categories" },
  { type: "pie", label: "Pie", hint: "Share of a whole (few categories)" },
  { type: "treemap", label: "Treemap", hint: "Share of a whole (many categories)" },
];

export const AGGS: { value: AggFn; label: string; sql: (c: string) => string }[] = [
  { value: "sum", label: "Sum", sql: (c) => `sum(${c})` },
  { value: "mean", label: "Average", sql: (c) => `avg(${c})` },
  { value: "median", label: "Median", sql: (c) => `median(${c})` },
  { value: "min", label: "Min", sql: (c) => `min(${c})` },
  { value: "max", label: "Max", sql: (c) => `max(${c})` },
  { value: "count", label: "Count", sql: (c) => `count(${c})` },
];

/** Most categories a single colour shelf shows before folding into "Other". */
export const MAX_SERIES = 8;
const OTHER = "Other";

type K = ColumnKind | undefined;
const isCat = (k: K) => k === "category" || k === "boolean" || k === "text";

/**
 * Smart chart suggestions from the kinds of the columns on the X and Y shelves.
 * The first entry is the best fit.
 */
export function recommend(xk: K, yk: K): ChartType[] {
  if (xk === "number" && yk === "number") return ["scatter", "line"];
  if (xk === "date" && yk === "number") return ["line", "area", "bar"];
  if (isCat(xk) && yk === "number") return ["bar", "box", "treemap", "pie"];
  if (isCat(xk) && isCat(yk)) return ["heatmap"];
  if (xk === "date" && isCat(yk)) return ["heatmap"];
  if (xk === "number" && isCat(yk)) return ["box"];
  if (xk === "number" && !yk) return ["histogram", "bar"];
  if (isCat(xk) && !yk) return ["bar", "pie", "treemap"];
  if (xk === "date" && !yk) return ["line", "bar"];
  if (!xk && yk === "number") return ["box", "histogram"];
  return ["bar"];
}

/** Why a chart type can't draw the current shelves, or null if it can. */
export function incompatible(spec: ChartSpec, cols: ColumnInfo[]): string | null {
  const k = (n?: string) => cols.find((c) => c.name === n)?.kind;
  const xk = k(spec.x);
  const yk = k(spec.y);
  switch (spec.type) {
    case "scatter":
      return xk === "number" && yk === "number" ? null : "Scatter needs numbers on both X and Y.";
    case "histogram":
      return xk === "number" || (!spec.x && yk === "number") ? null : "Histogram needs a number on X.";
    case "box":
      return yk === "number" || xk === "number" ? null : "Box plot needs a number on Y.";
    case "heatmap":
      return spec.x && spec.y && yk !== "number" ? null : "Heatmap needs categories on both X and Y (value on Size).";
    case "pie":
    case "treemap":
      return spec.x && xk !== "number" ? null : "Put a category on X.";
    default:
      if (!spec.x) return "Drag a column onto X.";
      if (spec.y && yk !== "number") return "Y must be a number (or empty to count rows).";
      return null;
  }
}

function measure(spec: ChartSpec, column = spec.y) {
  if (!column) return "count(*)";
  return AGGS.find((a) => a.value === spec.agg)!.sql(ident(column));
}

export const measureLabel = (spec: ChartSpec, column = spec.y) =>
  column ? `${AGGS.find((a) => a.value === spec.agg)!.label} of ${column}` : "Count of rows";

async function resolveGrain(table: string, x: string, grain: Grain): Promise<Exclude<Grain, "auto">> {
  if (grain !== "auto") return grain;
  const [{ days }] = await query<{ days: number }>(
    `SELECT date_diff('day', min(${ident(x)})::DATE, max(${ident(x)})::DATE) AS days FROM ${table}`,
  );
  return days > 365 * 3 ? "quarter" : days > 180 ? "month" : days > 45 ? "week" : "day";
}

/** Fold the colour column to its top categories plus "Other", so colours stay stable and few. */
async function colorExpr(table: string, color: string, spec: ChartSpec) {
  const c = ident(color);
  const top = await query<{ v: string }>(
    `SELECT CAST(${c} AS VARCHAR) AS v FROM ${table} WHERE ${c} IS NOT NULL GROUP BY 1 ORDER BY ${measure(spec)} DESC LIMIT ${MAX_SERIES}`,
  );
  const [{ n }] = await query<{ n: number }>(`SELECT count(DISTINCT ${c}) AS n FROM ${table}`);
  const keep = top.map((t) => t.v);
  const expr =
    n > MAX_SERIES
      ? `CASE WHEN CAST(${c} AS VARCHAR) IN (${keep.map((v) => `'${v.replace(/'/g, "''")}'`).join(", ")}) THEN CAST(${c} AS VARCHAR) ELSE '${OTHER}' END`
      : `CAST(${c} AS VARCHAR)`;
  // Order series by their natural value so a filter never repaints the survivors.
  return { expr, order: [...keep].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })), folded: n > MAX_SERIES };
}

export interface ChartData {
  option: (t: ThemeColors) => EChartsOption;
  note?: string;
  rows: number;
}

export async function buildChart(ds: Dataset, spec: ChartSpec): Promise<ChartData> {
  const T = ident(ds.table);
  const kind = (n?: string) => ds.columns.find((c) => c.name === n)?.kind;
  const xk = kind(spec.x);
  const notes: string[] = [];

  // ---- scatter
  if (spec.type === "scatter") {
    const x = ident(spec.x!);
    const y = ident(spec.y!);
    const col = spec.color ? await colorExpr(T, spec.color, { ...spec, y: undefined }) : null;
    const size = spec.size && kind(spec.size) === "number" ? ident(spec.size) : null;
    const [{ n }] = await query<{ n: number }>(`SELECT count(*) AS n FROM ${T} WHERE ${x} IS NOT NULL AND ${y} IS NOT NULL`);
    const rows = await query<{ x: number; y: number; g?: string; s?: number }>(
      `SELECT ${x}::DOUBLE AS x, ${y}::DOUBLE AS y${col ? `, ${col.expr} AS g` : ""}${size ? `, ${size}::DOUBLE AS s` : ""}
       FROM ${T} WHERE ${x} IS NOT NULL AND ${y} IS NOT NULL ${n > 5000 ? "USING SAMPLE 5000 ROWS" : ""}`,
    );
    if (n > 5000) notes.push(`Showing a random sample of 5,000 of ${n.toLocaleString()} points.`);
    if (col && col.order.length > 3) notes.push("With more than 3 colour groups, overlapping points are hard to tell apart; consider facets or fewer groups.");
    const sizes = rows.map((r) => r.s ?? 0);
    const [smin, smax] = [Math.min(...sizes), Math.max(...sizes)];
    const symbolSize = (r: { s?: number }) =>
      size && smax > smin ? 6 + 22 * Math.sqrt(((r.s ?? smin) - smin) / (smax - smin)) : 8;
    const groups = col ? [...col.order, ...(col.folded ? [OTHER] : [])] : [null];
    return {
      rows: n,
      note: notes.join(" "),
      option: (t) => ({
        ...base(t, groups.length > 1),
        tooltip: { trigger: "item" },
        xAxis: valueAxis(t, spec.x!),
        yAxis: valueAxis(t, spec.y!, true),
        series: groups.map((g, i) => ({
          type: "scatter",
          name: g ?? spec.y,
          data: rows.filter((r) => (g === null ? true : r.g === g)).map((r) => [r.x, r.y, r.s]),
          symbolSize: (v: number[]) => symbolSize({ s: v[2] }),
          itemStyle: { color: seriesColor(t, g, i), opacity: 0.75, borderColor: t.surface, borderWidth: 1 },
        })),
      }),
    };
  }

  // ---- histogram
  if (spec.type === "histogram") {
    const colName = spec.x && xk === "number" ? spec.x : spec.y!;
    const c = ident(colName);
    const [{ lo, hi, n }] = await query<{ lo: number; hi: number; n: number }>(
      `SELECT min(${c})::DOUBLE AS lo, max(${c})::DOUBLE AS hi, count(${c}) AS n FROM ${T}`,
    );
    const bins = Math.min(40, Math.max(5, Math.ceil(Math.log2(Math.max(n, 1)) + 1)));
    const w = (hi - lo) / bins || 1;
    const counts = new Array(bins).fill(0);
    for (const r of await query<{ b: number; c: number }>(
      `SELECT LEAST(FLOOR((${c} - ${lo}) / ${w})::INTEGER, ${bins - 1}) AS b, count(*) AS c FROM ${T} WHERE ${c} IS NOT NULL GROUP BY 1`,
    ))
      counts[r.b] = r.c;
    const label = (i: number) => `${fmt(lo + i * w)} – ${fmt(lo + (i + 1) * w)}`;
    return {
      rows: n,
      option: (t) => ({
        ...base(t, false),
        tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
        xAxis: { ...categoryAxis(t, colName, counts.map((_, i) => label(i))), axisLabel: { color: t.muted, interval: Math.ceil(bins / 8) - 1, formatter: (v: string) => v.split(" – ")[0] } },
        yAxis: valueAxis(t, "Rows", true),
        series: [{ type: "bar", name: "Rows", data: counts, barCategoryGap: 1, itemStyle: { color: t.series[0], borderRadius: [4, 4, 0, 0] } }],
      }),
    };
  }

  // ---- box plot
  if (spec.type === "box") {
    const value = kind(spec.y) === "number" ? spec.y! : spec.x!;
    const group = value === spec.y ? spec.x : spec.y;
    const v = ident(value);
    const g = group ? ident(group) : null;
    const stats = await query<{ g: string; q1: number; q2: number; q3: number; lo: number; hi: number; n: number }>(
      `SELECT ${g ? `CAST(${g} AS VARCHAR)` : "'all'"} AS g, quantile_cont(${v}, 0.25) AS q1, median(${v}) AS q2,
              quantile_cont(${v}, 0.75) AS q3, min(${v})::DOUBLE AS lo, max(${v})::DOUBLE AS hi, count(${v}) AS n
       FROM ${T} WHERE ${v} IS NOT NULL ${g ? `AND ${g} IS NOT NULL` : ""} GROUP BY 1 ORDER BY 1 LIMIT ${spec.topN}`,
    );
    // Whiskers stop at the furthest point within 1.5 × IQR (Tukey).
    const boxes = stats.map((s) => {
      const iqr = s.q3 - s.q1;
      return [Math.max(s.lo, s.q1 - 1.5 * iqr), s.q1, s.q2, s.q3, Math.min(s.hi, s.q3 + 1.5 * iqr)];
    });
    return {
      rows: stats.reduce((a, s) => a + s.n, 0),
      option: (t) => ({
        ...base(t, false),
        tooltip: {
          trigger: "item",
          formatter: (p: { name: string; dataIndex: number }) => {
            const [lo, q1, q2, q3, hi] = boxes[p.dataIndex];
            const s = stats[p.dataIndex];
            return `<b>${p.name}</b> (${s.n.toLocaleString()} rows)<br/>upper whisker ${fmt(hi)}<br/>Q3 ${fmt(q3)}<br/>median ${fmt(q2)}<br/>Q1 ${fmt(q1)}<br/>lower whisker ${fmt(lo)}`;
          },
        },
        xAxis: categoryAxis(t, group ?? "", stats.map((s) => s.g)),
        yAxis: valueAxis(t, value, true),
        series: [{ type: "boxplot", data: boxes, itemStyle: { color: withAlpha(t.series[0], 0.18), borderColor: t.series[0], borderWidth: 1.5 } }],
      }),
    };
  }

  // ---- heatmap
  if (spec.type === "heatmap") {
    const val = spec.size && kind(spec.size) === "number" ? spec.size : undefined;
    const m = measure(spec, val);
    const x = ident(spec.x!);
    const y = ident(spec.y!);
    const top = async (c: string) =>
      (await query<{ v: string }>(`SELECT CAST(${c} AS VARCHAR) AS v FROM ${T} WHERE ${c} IS NOT NULL GROUP BY 1 ORDER BY count(*) DESC LIMIT 30`)).map((r) => r.v).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const [xs, ys] = await Promise.all([top(x), top(y)]);
    const cells = await query<{ x: string; y: string; v: number }>(
      `SELECT CAST(${x} AS VARCHAR) AS x, CAST(${y} AS VARCHAR) AS y, ${m}::DOUBLE AS v FROM ${T} GROUP BY 1, 2`,
    );
    const data = cells.filter((c) => xs.includes(c.x) && ys.includes(c.y)).map((c) => [xs.indexOf(c.x), ys.indexOf(c.y), c.v]);
    const vals = data.map((d) => d[2] as number);
    return {
      rows: cells.length,
      note: xs.length === 30 || ys.length === 30 ? "Showing the 30 most common values on each axis." : undefined,
      option: (t) => ({
        ...base(t, false),
        grid: { left: 8, right: 16, top: 16, bottom: 56, containLabel: true },
        tooltip: { formatter: (p: { value: number[] }) => `${xs[p.value[0]]} × ${ys[p.value[1]]}<br/><b>${measureLabel(spec, val)}: ${fmt(p.value[2])}</b>` },
        xAxis: categoryAxis(t, spec.x!, xs),
        yAxis: { ...categoryAxis(t, spec.y!, ys), nameLocation: "end" },
        visualMap: {
          min: Math.min(...vals, 0),
          max: Math.max(...vals, 1),
          calculable: true,
          orient: "horizontal",
          left: "center",
          bottom: 0,
          textStyle: { color: t.muted },
          // Sequential: one hue, light → dark
          inRange: { color: ["#cde2fb", "#86b6ef", "#3987e5", "#1c5cab", "#0d366b"] },
        },
        series: [{ type: "heatmap", data, itemStyle: { borderColor: t.surface, borderWidth: 2 }, label: { show: xs.length * ys.length <= 80, color: t.text, formatter: (p: { value: number[] }) => fmt(p.value[2]) } }],
      }),
    };
  }

  // ---- bar / line / area / pie / treemap: aggregate by X (and colour)
  const isDate = xk === "date";
  const grain = isDate ? await resolveGrain(T, spec.x!, spec.grain) : null;
  const xExpr = isDate ? `date_trunc('${grain}', ${ident(spec.x!)})` : ident(spec.x!);
  const m = measure(spec);
  const ordered = isDate || xk === "number";

  // Keep the top N categories by value (dates and numbers keep their natural order).
  let xFilter = "";
  if (!ordered) {
    const [{ n }] = await query<{ n: number }>(`SELECT count(DISTINCT ${xExpr}) AS n FROM ${T}`);
    const limit = spec.type === "pie" ? MAX_SERIES : spec.topN;
    if (n > limit) {
      notes.push(`Showing the top ${limit} of ${n} ${spec.x} values.`);
      xFilter = `AND CAST(${xExpr} AS VARCHAR) IN (SELECT CAST(${xExpr} AS VARCHAR) FROM ${T} GROUP BY 1 ORDER BY ${m} DESC NULLS LAST LIMIT ${limit})`;
    }
  }
  const col = spec.color && spec.type !== "pie" && spec.type !== "treemap" ? await colorExpr(T, spec.color, spec) : null;
  if (col?.folded) notes.push(`${spec.color} has more than ${MAX_SERIES} values; the rest are grouped as "${OTHER}".`);

  const rows = await query<{ x: string | number; g?: string; v: number }>(
    `SELECT ${isDate ? `strftime(${xExpr}, '${grain === "year" ? "%Y" : grain === "month" || grain === "quarter" ? "%Y-%m" : "%Y-%m-%d"}')` : ordered ? xExpr : `CAST(${xExpr} AS VARCHAR)`} AS x,
            ${col ? `${col.expr} AS g,` : ""} ${m}::DOUBLE AS v
     FROM ${T} WHERE ${ident(spec.x!)} IS NOT NULL ${xFilter}
     GROUP BY ALL ORDER BY ${ordered ? "x" : "v DESC"}`,
  );

  // Category order: by total value (desc) for categories; natural for dates/numbers.
  const xs: string[] = [];
  const totals = new Map<string, number>();
  for (const r of rows) {
    const k = String(r.x);
    if (!totals.has(k)) xs.push(k);
    totals.set(k, (totals.get(k) ?? 0) + (r.v ?? 0));
  }
  if (!ordered) xs.sort((a, b) => totals.get(b)! - totals.get(a)!);
  const label = measureLabel(spec);
  const xLabel = isDate ? `${spec.x} (by ${grain})` : spec.x!;

  if (spec.type === "pie" || spec.type === "treemap") {
    const items = xs.map((x) => ({ name: x, value: totals.get(x)! }));
    return {
      rows: rows.length,
      note: notes.join(" "),
      option: (t) =>
        spec.type === "pie"
          ? {
              ...base(t, false),
              tooltip: { trigger: "item", formatter: (p: { name: string; value: number; percent: number }) => `${p.name}<br/><b>${fmt(p.value)}</b> (${p.percent}%)` },
              series: [
                {
                  type: "pie",
                  radius: ["45%", "72%"],
                  data: items.map((it, i) => ({ ...it, itemStyle: { color: t.series[i % MAX_SERIES] } })),
                  itemStyle: { borderColor: t.surface, borderWidth: 2 },
                  label: { color: t.text, formatter: "{b}\n{d}%" },
                  labelLine: { lineStyle: { color: t.muted } },
                },
              ],
            }
          : {
              ...base(t, false),
              tooltip: { formatter: (p: { name: string; value: number }) => `${p.name}<br/><b>${label}: ${fmt(p.value)}</b>` },
              series: [
                {
                  type: "treemap",
                  data: items.map((it, i) => ({ ...it, itemStyle: { color: i < MAX_SERIES ? t.series[i] : t.other } })),
                  roam: false,
                  nodeClick: false,
                  breadcrumb: { show: false },
                  itemStyle: { borderColor: t.surface, borderWidth: 2, gapWidth: 2 },
                  label: { color: "#fff", formatter: "{b}" },
                },
              ],
            },
    };
  }

  const groups = col ? [...col.order, ...(col.folded ? [OTHER] : [])] : [null];
  const seriesData = (g: string | null) => {
    const byX = new Map(rows.filter((r) => (g === null ? true : r.g === g)).map((r) => [String(r.x), r.v]));
    return xs.map((x) => byX.get(x) ?? (spec.type === "bar" ? 0 : null));
  };

  return {
    rows: rows.length,
    note: notes.join(" "),
    option: (t) => ({
      ...base(t, groups.length > 1),
      tooltip: { trigger: "axis", axisPointer: { type: spec.type === "bar" ? "shadow" : "line" }, valueFormatter: (v: number) => fmt(v) },
      xAxis: { ...categoryAxis(t, xLabel, xs), boundaryGap: spec.type === "bar" },
      yAxis: valueAxis(t, label, true),
      series: groups.map((g, i) => ({
        type: spec.type === "bar" ? "bar" : "line",
        name: g ?? label,
        data: seriesData(g),
        stack: spec.stack && groups.length > 1 ? "total" : undefined,
        showSymbol: xs.length <= 40,
        symbolSize: 8,
        connectNulls: false,
        lineStyle: { width: 2 },
        areaStyle: spec.type === "area" ? { opacity: spec.stack ? 0.85 : 0.15 } : undefined,
        itemStyle: {
          color: seriesColor(t, g, i),
          borderRadius: spec.type === "bar" ? (spec.stack && groups.length > 1 ? 0 : [4, 4, 0, 0]) : undefined,
          borderColor: spec.type === "bar" && spec.stack ? t.surface : undefined,
          borderWidth: spec.type === "bar" && spec.stack ? 1 : undefined,
        },
        barMaxWidth: 48,
      })),
    }),
  };
}

// ---------- shared chart anatomy ----------

function seriesColor(t: ThemeColors, g: string | null, i: number) {
  return g === OTHER ? t.other : t.series[i % MAX_SERIES];
}

function base(t: ThemeColors, legend: boolean): EChartsOption {
  return {
    backgroundColor: "transparent",
    textStyle: { fontFamily: "inherit", color: t.text },
    grid: { left: 8, right: 24, top: legend ? 44 : 20, bottom: 8, containLabel: true },
    legend: legend ? { top: 0, type: "scroll", textStyle: { color: t.text }, icon: "roundRect", itemWidth: 12, itemHeight: 12 } : undefined,
    animationDuration: 300,
  };
}

function categoryAxis(t: ThemeColors, name: string, data: string[]) {
  const long = data.length > 8 || data.some((d) => d.length > 12);
  return {
    type: "category",
    data,
    name,
    nameLocation: "middle",
    nameGap: long ? 70 : 30,
    nameTextStyle: { color: t.muted },
    axisLabel: { color: t.muted, rotate: long ? 35 : 0, hideOverlap: true, formatter: (v: string) => (v.length > 18 ? `${v.slice(0, 17)}…` : v) },
    axisLine: { lineStyle: { color: t.border } },
    axisTick: { show: false },
  };
}

function valueAxis(t: ThemeColors, name: string, vertical = false) {
  return {
    type: "value",
    name,
    nameLocation: "middle",
    nameGap: vertical ? 52 : 30,
    nameTextStyle: { color: t.muted },
    scale: !vertical,
    axisLabel: { color: t.muted, formatter: (v: number) => compact(v) },
    splitLine: { lineStyle: { color: t.grid } },
    axisLine: { show: false },
  };
}

export function fmt(v: number | null | undefined) {
  if (v === null || v === undefined || Number.isNaN(v)) return "–";
  if (Number.isInteger(v)) return v.toLocaleString();
  return Math.abs(v) >= 100 ? v.toLocaleString(undefined, { maximumFractionDigits: 1 }) : Number(v.toPrecision(4)).toString();
}

function compact(v: number) {
  return Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(v);
}

function withAlpha(hex: string, a: number) {
  const m = hex.match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  return m ? `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${a})` : hex;
}
