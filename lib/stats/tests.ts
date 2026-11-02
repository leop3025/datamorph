"use client";

import type { ColumnKind, Dataset } from "@/lib/data/types";
import { callPython, frameFile } from "@/lib/python/client";
import { fmt } from "@/lib/charts/builder";

export type TestId = "ttest" | "anova" | "chisquare" | "correlation" | "normality";

export const TEST_INFO: Record<TestId, { name: string; question: string }> = {
  ttest: { name: "Welch's t-test", question: "Is the average different between two groups?" },
  anova: { name: "One-way ANOVA", question: "Is the average different across several groups?" },
  chisquare: { name: "Chi-square test", question: "Are two categories related?" },
  correlation: { name: "Correlation", question: "Do two numbers move together?" },
  normality: { name: "Shapiro-Wilk + Q-Q plot", question: "Is this number normally distributed?" },
};

const isCat = (k?: ColumnKind) => k === "category" || k === "boolean" || k === "text";

/** Pick the right test from the column types (and how many groups B has). */
export function suggestTest(a?: ColumnKind, b?: ColumnKind, groupsB = 0): TestId | null {
  if (a === "number" && !b) return "normality";
  if (a === "number" && isCat(b)) return groupsB === 2 ? "ttest" : "anova";
  if (isCat(a) && b === "number") return groupsB === 2 ? "ttest" : "anova";
  if (isCat(a) && isCat(b)) return "chisquare";
  if (a === "number" && b === "number") return "correlation";
  return null;
}

export interface TestResult {
  test: string;
  statistic: number;
  p: number;
  df?: number | number[];
  n?: number;
  effect?: { name: string; value: number | null };
  groups?: { group: string; n: number; mean: number; median: number; std: number | null }[];
  alternative?: { test: string; statistic: number; p: number };
  checks?: { normal_p?: (number | null)[]; levene_p?: number; low_expected_share?: number };
  table?: { rows: string[]; cols: string[]; values: number[][]; row_pct: number[][] };
  fit?: { slope: number; intercept: number };
  points?: [number, number][];
  qq?: { theoretical: number[]; observed: number[]; slope: number; intercept: number };
  skew?: number;
  kurtosis?: number;
  sampled?: boolean | number | null;
}

export interface TestRequest {
  test: TestId;
  a: string;
  b?: string;
  levels?: string[];
  method?: "pearson" | "spearman";
}

export async function runTest(ds: Dataset, req: TestRequest, onProgress: (m: string) => void): Promise<TestResult> {
  const columns = [req.a, req.b].filter(Boolean) as string[];
  const path = `/data/${ds.table}_v${ds.version}_${columns.join("__").replace(/[^A-Za-z0-9_]/g, "_")}.csv`;
  onProgress("Preparing data…");
  const { file, dates, sampled } = await frameFile(ds, columns, path);
  const kindA = ds.columns.find((c) => c.name === req.a)?.kind;
  const value = kindA === "number" ? req.a : req.b!;
  const group = kindA === "number" ? req.b! : req.a;
  const args: Record<string, Record<string, unknown>> = {
    ttest: { value, group, levels: req.levels },
    anova: { value, group },
    chisquare: { a: req.a, b: req.b },
    correlation: { x: req.a, y: req.b, method: req.method ?? "pearson" },
    normality: { value: req.a },
  };
  const result = await callPython<TestResult>(
    req.test,
    { path, dates, fresh: true, ...args[req.test] },
    { packages: ["scipy"], sections: ["stats"], files: [file], onProgress },
  );
  return { ...result, sampled: sampled ?? result.sampled };
}

// ---------- plain-English explanations ----------

export const formatP = (p: number) => (p < 0.001 ? "p < 0.001" : `p = ${p.toFixed(3)}`);

function effectLabel(name: string, v: number) {
  const a = Math.abs(v);
  const cut =
    name === "Cohen's d" ? [0.2, 0.5, 0.8] : name === "eta squared" ? [0.01, 0.06, 0.14] : name === "Cramér's V" ? [0.1, 0.3, 0.5] : [0.1, 0.3, 0.5];
  const words = name === "r" || name === "rho" ? ["negligible", "weak", "moderate", "strong"] : ["negligible", "small", "medium", "large"];
  return words[cut.filter((c) => a >= c).length];
}

export interface Explanation {
  headline: string;
  significant: boolean;
  details: string[];
  cautions: string[];
}

export function explain(req: TestRequest, r: TestResult, kindA?: ColumnKind): Explanation {
  const sig = r.p < 0.05;
  const p = formatP(r.p);
  const value = kindA === "number" ? req.a : req.b!;
  const group = kindA === "number" ? req.b! : req.a;
  const details: string[] = [];
  const cautions: string[] = [];
  const eff = r.effect?.value ?? null;
  let headline = "";

  if (req.test === "ttest") {
    const [g1, g2] = r.groups!;
    headline = sig
      ? `Average ${value} differs significantly between ${g1.group} (${fmt(g1.mean)}) and ${g2.group} (${fmt(g2.mean)}) (${p}), so this is unlikely to be chance.`
      : `Average ${value} is ${fmt(g1.mean)} for ${g1.group} and ${fmt(g2.mean)} for ${g2.group}, but the difference is not statistically significant (${p}). It could easily be chance.`;
    if (eff !== null) details.push(`The size of the difference is ${effectLabel("Cohen's d", eff)} (Cohen's d = ${eff.toFixed(2)}).`);
    const nonNormal = r.checks?.normal_p?.some((q, i) => q !== null && q < 0.05 && r.groups![i].n < 30);
    if (nonNormal)
      cautions.push(`A small group doesn't look normally distributed; the Mann-Whitney test (${formatP(r.alternative!.p)}) is the safer read.`);
    details.push("Welch's version is used, so the groups don't need equal variances.");
  } else if (req.test === "anova") {
    const gs = [...r.groups!].sort((a, b) => b.mean - a.mean);
    headline = sig
      ? `Average ${value} differs significantly between ${group} groups (${p}), so this is unlikely to be chance.`
      : `Average ${value} doesn't differ significantly between ${group} groups (${p}). The differences could be chance.`;
    details.push(`Highest: ${gs[0].group} (${fmt(gs[0].mean)}). Lowest: ${gs[gs.length - 1].group} (${fmt(gs[gs.length - 1].mean)}).`);
    if (eff !== null)
      details.push(`${group} explains ${(eff * 100).toFixed(1)}% of the variation in ${value} (eta² = ${eff.toFixed(3)}, a ${effectLabel("eta squared", eff)} effect).`);
    if ((r.checks?.levene_p ?? 1) < 0.05)
      cautions.push(`Group variances differ (Levene ${formatP(r.checks!.levene_p!)}); the Kruskal-Wallis test (${formatP(r.alternative!.p)}) doesn't assume equal variances.`);
    if (sig) details.push("ANOVA says the groups differ somewhere; it doesn't say which pairs. Compare two groups with a t-test to find out.");
  } else if (req.test === "chisquare") {
    headline = sig
      ? `${req.a} and ${req.b} are related (${p}): the mix of ${req.b} differs across ${req.a} groups. This is unlikely to be chance.`
      : `There's no significant relationship between ${req.a} and ${req.b} (${p}).`;
    if (eff !== null) details.push(`Association strength is ${effectLabel("Cramér's V", eff)} (Cramér's V = ${eff.toFixed(2)}, from 0 = none to 1 = perfect).`);
    if (sig && r.table) {
      // Point to the cell that deviates most from its column's overall share.
      const { rows, cols, values } = r.table;
      const total = values.flat().reduce((s, v) => s + v, 0);
      let best = { row: 0, col: 0, diff: 0, pct: 0, base: 0 };
      cols.forEach((_, j) => {
        const base = values.reduce((s, row) => s + row[j], 0) / total;
        rows.forEach((_, i) => {
          const rowTotal = values[i].reduce((s, v) => s + v, 0);
          const pct = values[i][j] / rowTotal;
          if (Math.abs(pct - base) > Math.abs(best.diff)) best = { row: i, col: j, diff: pct - base, pct, base };
        });
      });
      details.push(
        `Biggest gap: ${(best.pct * 100).toFixed(0)}% of ${req.a} = ${rows[best.row]} have ${req.b} = ${cols[best.col]}, versus ${(best.base * 100).toFixed(0)}% overall.`,
      );
    }
    if ((r.checks?.low_expected_share ?? 0) > 0.2)
      cautions.push("More than 20% of cells expect fewer than 5 rows, so the chi-square approximation is unreliable. Merge rare categories.");
  } else if (req.test === "correlation") {
    const rr = r.statistic;
    const dir = rr > 0 ? "positive" : "negative";
    headline = sig
      ? `${req.a} and ${req.b} have a ${effectLabel(r.effect!.name, rr)} ${dir} relationship (${r.effect!.name} = ${rr.toFixed(2)}, ${p}): as ${req.a} increases, ${req.b} tends to ${rr > 0 ? "increase" : "decrease"}.`
      : `There's no significant ${req.method === "spearman" ? "monotonic" : "linear"} relationship between ${req.a} and ${req.b} (${r.effect!.name} = ${rr.toFixed(2)}, ${p}).`;
    details.push(`${(rr * rr * 100).toFixed(1)}% of the variation in one is shared with the other (r² = ${(rr * rr).toFixed(3)}).`);
    if (r.alternative) details.push(`${r.alternative.test}: ${r.alternative.statistic.toFixed(2)} (${formatP(r.alternative.p)}).`);
    cautions.push("Correlation is not causation: a third factor may drive both.");
  } else {
    headline =
      r.p < 0.05
        ? `${req.a} is not normally distributed (Shapiro-Wilk ${p}).`
        : `${req.a} is consistent with a normal distribution (Shapiro-Wilk ${p}).`;
    if (r.skew !== undefined)
      details.push(
        `Skewness ${r.skew.toFixed(2)} (${Math.abs(r.skew) < 0.5 ? "roughly symmetric" : r.skew > 0 ? "long tail to the right" : "long tail to the left"}), excess kurtosis ${r.kurtosis!.toFixed(2)}.`,
      );
    details.push("On the Q-Q plot, points on the line mean normal; curves at the ends mean heavy or light tails.");
    if (r.p < 0.05)
      cautions.push("Prefer non-parametric tests (Mann-Whitney, Kruskal-Wallis) or try a log transform for skewed data.");
    if ((r.n ?? 0) > 5000) cautions.push("With thousands of rows, tiny deviations become 'significant'. Trust the Q-Q plot more than the p-value.");
  }
  if (r.sampled) cautions.push(`Computed on a random sample of ${typeof r.sampled === "number" ? r.sampled.toLocaleString() : "5,000"} rows.`);
  return { headline, significant: sig, details, cautions };
}
