"use client";

import { ident, query } from "@/lib/duckdb/client";
import type { ColumnInfo, Dataset } from "@/lib/data/types";

export interface ColumnProfile {
  column: ColumnInfo;
  missing: number;
  missingPct: number;
  unique: number;
  // numeric only
  mean?: number;
  median?: number;
  std?: number;
  min?: number | string;
  max?: number | string;
  skew?: number;
  outliers?: number;
  histogram?: { from: number; to: number; count: number }[];
  // categorical / text / boolean
  topValues?: { value: string; count: number }[];
  /** share of non-null text values that parse as numbers (mixed-type signal) */
  numericShare?: number;
}

export interface Warning {
  level: "info" | "warn" | "critical";
  column?: string;
  message: string;
  /** One-click fix: a recipe step to add */
  fix?: { label: string; type: string; params: Record<string, unknown> };
}

export interface QualityScore {
  score: number;
  breakdown: { label: string; penalty: number; detail: string }[];
}

export interface Profile {
  rowCount: number;
  duplicateRows: number;
  columns: ColumnProfile[];
  warnings: Warning[];
  quality: QualityScore;
  correlation: { columns: string[]; matrix: (number | null)[][] } | null;
  elapsedMs: number;
}

const HIST_BINS = 20;
const MAX_CORR_COLS = 16;

const num = (v: unknown) => (v === null || v === undefined || v === "" ? undefined : Number(v));

export async function profileDataset(ds: Dataset): Promise<Profile> {
  const t0 = performance.now();
  const T = ident(ds.table);
  const n = ds.rowCount;

  // 1. One pass of basic stats for every column.
  const parts = ds.columns.flatMap((c, i) => {
    const col = ident(c.name);
    const base = [`COUNT(*) - COUNT(${col}) AS m${i}`, `approx_count_distinct(${col}) AS u${i}`];
    if (c.kind === "number") {
      const x = `CAST(${col} AS DOUBLE)`;
      base.push(
        `avg(${x}) AS mean${i}`,
        `median(${x}) AS med${i}`,
        `stddev_samp(${x}) AS sd${i}`,
        `min(${x}) AS min${i}`,
        `max(${x}) AS max${i}`,
        `skewness(${x}) AS sk${i}`,
        `quantile_cont(${x}, 0.25) AS q1${i}`,
        `quantile_cont(${x}, 0.75) AS q3${i}`,
      );
    } else if (c.kind === "date") {
      base.push(`CAST(min(${col}) AS VARCHAR) AS min${i}`, `CAST(max(${col}) AS VARCHAR) AS max${i}`);
    } else if (c.duckType === "VARCHAR") {
      base.push(
        `COUNT(TRY_CAST(${col} AS DOUBLE)) / NULLIF(COUNT(${col}), 0) AS ns${i}`,
      );
    }
    return base;
  });
  const [stats] = n > 0 ? await query(`SELECT ${parts.join(", ")} FROM ${T}`) : [{}];

  const columns: ColumnProfile[] = ds.columns.map((c, i) => {
    const missing = Number(stats[`m${i}`] ?? 0);
    const p: ColumnProfile = {
      column: c,
      missing,
      missingPct: n ? missing / n : 0,
      unique: Math.min(Number(stats[`u${i}`] ?? 0), n - missing),
    };
    if (c.kind === "number") {
      Object.assign(p, {
        mean: num(stats[`mean${i}`]),
        median: num(stats[`med${i}`]),
        std: num(stats[`sd${i}`]),
        min: num(stats[`min${i}`]),
        max: num(stats[`max${i}`]),
        skew: num(stats[`sk${i}`]),
      });
    } else if (c.kind === "date") {
      p.min = stats[`min${i}`] as string;
      p.max = stats[`max${i}`] as string;
    } else if (c.duckType === "VARCHAR") {
      p.numericShare = num(stats[`ns${i}`]);
    }
    return p;
  });

  // 2. Histogram + IQR outlier count per numeric column: one cheap GROUP BY scan each
  //    (the outlier count rides along as a per-bin sum). Measured faster than one wide
  //    query with 20 filtered counts per column.
  await Promise.all(
    columns.map(async (p, i) => {
      if (p.column.kind !== "number" || p.min === undefined || p.max === undefined) return;
      const col = `CAST(${ident(p.column.name)} AS DOUBLE)`;
      const lo = p.min as number;
      const width = ((p.max as number) - lo) / HIST_BINS || 1;
      const q1 = num(stats[`q1${i}`]);
      const q3 = num(stats[`q3${i}`]);
      const isOut =
        q1 !== undefined && q3 !== undefined ? `(${col} < ${q1 - 1.5 * (q3 - q1)} OR ${col} > ${q3 + 1.5 * (q3 - q1)})` : "false";
      const bins = await query<{ b: number; c: number; o: number }>(
        `SELECT LEAST(CAST(FLOOR((${col} - ${lo}) / ${width}) AS INTEGER), ${HIST_BINS - 1}) AS b,
                count(*) AS c, count(*) FILTER (WHERE ${isOut}) AS o
         FROM ${T} WHERE ${col} IS NOT NULL GROUP BY b`,
      );
      const counts = new Array(HIST_BINS).fill(0);
      for (const { b, c } of bins) counts[b] = c;
      p.histogram = counts.map((count, b) => ({ from: lo + b * width, to: lo + (b + 1) * width, count }));
      p.outliers = bins.reduce((s, r) => s + r.o, 0);
    }),
  );

  // 3. Top values for categories, text and booleans (dates show their range instead).
  await Promise.all(
    columns.map(async (p) => {
      if (p.column.kind === "number" || p.column.kind === "date") return;
      const col = ident(p.column.name);
      p.topValues = (
        await query<{ v: string; c: number }>(
          `SELECT CAST(${col} AS VARCHAR) AS v, COUNT(*) AS c FROM ${T}
           WHERE ${col} IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 5`,
        )
      ).map(({ v, c }) => ({ value: v, count: c }));
    }),
  );

  // 4. Duplicate rows.
  const [{ d }] = await query<{ d: number }>(
    // Compare one 64-bit hash per row instead of every column (collisions are negligible).
    `SELECT ${n} - count(DISTINCT hash(${ds.columns.map((c) => ident(c.name)).join(", ")})) AS d FROM ${T}`,
  );

  const correlation = await correlationMatrix(ds);
  const warnings = buildWarnings(columns, n, d);
  const quality = scoreQuality(columns, n, d);

  return {
    rowCount: n,
    duplicateRows: d,
    columns,
    warnings,
    quality,
    correlation,
    elapsedMs: performance.now() - t0,
  };
}

async function correlationMatrix(ds: Dataset): Promise<Profile["correlation"]> {
  const cols = ds.columns.filter((c) => c.kind === "number").map((c) => c.name).slice(0, MAX_CORR_COLS);
  if (cols.length < 2) return null;
  const pairs: string[] = [];
  for (let i = 0; i < cols.length; i++)
    for (let j = i + 1; j < cols.length; j++)
      pairs.push(
        `corr(CAST(${ident(cols[i])} AS DOUBLE), CAST(${ident(cols[j])} AS DOUBLE)) AS c_${i}_${j}`,
      );
  const [row] = await query(`SELECT ${pairs.join(", ")} FROM ${ident(ds.table)}`);
  const matrix = cols.map((_, i) =>
    cols.map((__, j) => {
      if (i === j) return 1;
      const v = row[`c_${Math.min(i, j)}_${Math.max(i, j)}`];
      return v === null || Number.isNaN(Number(v)) ? null : Number(v);
    }),
  );
  return { columns: cols, matrix };
}

const pct = (x: number) => `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`;

export function buildWarnings(columns: ColumnProfile[], n: number, dupes: number): Warning[] {
  const w: Warning[] = [];
  if (n === 0) return [{ level: "critical", message: "The dataset has no rows." }];
  if (dupes > 0)
    w.push({
      level: "warn",
      message: `${dupes.toLocaleString()} duplicate rows (${pct(dupes / n)} of the data).`,
      fix: { label: "Remove duplicates", type: "dropDuplicates", params: { columns: [] } },
    });

  for (const p of columns) {
    const name = p.column.name;
    if (p.missingPct === 1) {
      w.push({
        level: "critical",
        column: name,
        message: `${name} is completely empty. Consider dropping it.`,
        fix: { label: "Drop column", type: "dropColumns", params: { columns: [name] } },
      });
      continue;
    }
    if (p.missingPct >= 0.05) {
      const k = p.column.kind;
      const fix =
        k === "number"
          ? { label: "Fill with median", type: "fillMissing", params: { column: name, method: "median", value: "" } }
          : k === "category" || k === "boolean"
            ? { label: "Fill with most frequent", type: "fillMissing", params: { column: name, method: "mode", value: "" } }
            : { label: "Drop those rows", type: "dropMissing", params: { columns: [name] } };
      w.push({
        level: p.missingPct >= 0.4 ? "critical" : "warn",
        column: name,
        message: `${name} has ${pct(p.missingPct)} missing values.`,
        fix: p.missingPct >= 0.6 ? { label: "Drop column", type: "dropColumns", params: { columns: [name] } } : fix,
      });
    }

    const nonNull = n - p.missing;
    if (nonNull > 1 && p.unique <= 1)
      w.push({
        level: "warn",
        column: name,
        message: `${name} has a single constant value, so it carries no information.`,
        fix: { label: "Drop column", type: "dropColumns", params: { columns: [name] } },
      });

    const looksLikeId =
      /(^|_)id$|^id|uuid|key$/i.test(name) || (p.column.kind !== "number" && p.unique >= nonNull * 0.98 && nonNull > 20);
    if (looksLikeId && p.unique >= nonNull * 0.95 && nonNull > 1)
      w.push({ level: "info", column: name, message: `${name} looks like an identifier. Exclude it from analysis and modelling.` });

    if (p.skew !== undefined && Math.abs(p.skew) > 2)
      w.push({
        level: "info",
        column: name,
        message: `${name} is highly ${p.skew > 0 ? "right" : "left"}-skewed (skew ${p.skew.toFixed(1)}). A log transform may help.`,
      });

    if (p.outliers && p.outliers / nonNull >= 0.01)
      w.push({
        level: "info",
        column: name,
        message: `${name} has ${p.outliers.toLocaleString()} outliers by the IQR rule.`,
        fix: { label: "Cap outliers", type: "outliers", params: { column: name, method: "iqr", k: 1.5, action: "cap" } },
      });

    if (p.numericShare !== undefined && p.numericShare >= 0.5 && p.numericShare < 1)
      w.push({
        level: "warn",
        column: name,
        message: `${name} is mostly numbers (${pct(p.numericShare)}) but stored as text, so it has mixed types.`,
        fix: { label: "Convert to number", type: "changeType", params: { column: name, to: "number", format: "" } },
      });

    if (p.column.kind === "category" && p.topValues) {
      const vals = p.topValues.map((t) => t.value);
      const normalized = new Set(vals.map((v) => v.trim().toLowerCase()));
      if (normalized.size < vals.length)
        w.push({
          level: "warn",
          column: name,
          message: `${name} has values that differ only by case or spaces (e.g. "${vals.join('", "')}").`,
          fix: { label: "Trim + lowercase", type: "textClean", params: { column: name, op: "trimLower" } },
        });
    }
  }
  const order = { critical: 0, warn: 1, info: 2 };
  return w.sort((a, b) => order[a.level] - order[b.level]);
}

/**
 * Quality score (0–100). Each issue costs up to a fixed number of points:
 *  missing cells 40 · duplicate rows 25 · outliers 20 · mixed-type columns 15.
 * The multipliers make small problems visible: 10% missing cells already costs 16 points,
 * 5% duplicate rows costs 12.5.
 */
export function scoreQuality(columns: ColumnProfile[], n: number, dupes: number): QualityScore {
  if (n === 0 || columns.length === 0) return { score: 0, breakdown: [] };
  const cells = n * columns.length;
  const missingFrac = columns.reduce((s, p) => s + p.missing, 0) / cells;
  const dupFrac = dupes / n;
  const numeric = columns.filter((p) => p.outliers !== undefined);
  const outlierFrac = numeric.length
    ? numeric.reduce((s, p) => s + (p.outliers ?? 0) / Math.max(1, n - p.missing), 0) / numeric.length
    : 0;
  const mixed = columns.filter((p) => p.numericShare !== undefined && p.numericShare >= 0.5 && p.numericShare < 1).length;
  const mixedFrac = mixed / columns.length;

  const breakdown = [
    { label: "Missing values", penalty: Math.min(1, missingFrac * 4) * 40, detail: `${pct(missingFrac)} of cells` },
    { label: "Duplicate rows", penalty: Math.min(1, dupFrac * 10) * 25, detail: `${pct(dupFrac)} of rows` },
    { label: "Outliers", penalty: Math.min(1, outlierFrac * 10) * 20, detail: `${pct(outlierFrac)} avg per numeric column` },
    { label: "Mixed types", penalty: mixedFrac * 15, detail: `${mixed} column${mixed === 1 ? "" : "s"}` },
  ];
  const score = Math.round(100 - breakdown.reduce((s, b) => s + b.penalty, 0));
  return { score: Math.max(0, score), breakdown };
}
