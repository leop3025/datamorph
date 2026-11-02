"use client";

import { exec, getDB, ident, lit, query } from "@/lib/duckdb/client";
import type { Dataset } from "@/lib/data/types";
import { runPython } from "@/lib/python/client";
import { generateVerificationScript, usesSql } from "./codegen";

export interface Verification {
  ok: boolean;
  duck: { rows: number; columns: string[] };
  pandas: { rows: number; columns: string[] };
  problems: string[];
}

/** Datasets reachable through join steps, plus the dataset itself. */
function involved(ds: Dataset, all: Dataset[], seen = new Set<string>()): Dataset[] {
  if (seen.has(ds.id)) return [];
  seen.add(ds.id);
  const deps = ds.steps
    .filter((s) => s.enabled && s.type === "join")
    .map((s) => all.find((d) => d.id === s.params.right))
    .filter((d): d is Dataset => !!d);
  return [ds, ...deps.flatMap((d) => involved(d, all, seen))];
}

/**
 * Run the generated pandas code in Pyodide on the same source data and compare its result
 * with DuckDB's: row count, column names, and the total of every numeric column.
 */
export async function verifyRecipe(ds: Dataset, all: Dataset[], onProgress: (m: string) => void): Promise<Verification> {
  if (usesSql(ds, involved(ds, all)))
    throw new Error("SQL query steps export as duckdb code, and duckdb isn't available in the in-browser Python. Disable the SQL steps to verify the rest, or run the script locally.");
  onProgress("Exporting source data…");
  const db = await getDB();
  const files: { path: string; data: Uint8Array }[] = [];
  for (const d of involved(ds, all)) {
    const tmp = `verify_${d.table}.csv`;
    await exec(`COPY ${ident(d.sourceTable)} TO ${lit(tmp)} (HEADER, DELIMITER ',')`);
    files.push({ path: `/verify/${d.table}.csv`, data: await db.copyFileToBuffer(tmp) });
    await db.dropFile(tmp);
  }

  const script = generateVerificationScript(ds, all, (d) => `/verify/${d.table}.csv`);
  const pandas = JSON.parse(await runPython(script, { files, onProgress })) as {
    rows: number;
    columns: string[];
    sums: Record<string, number | null>;
  };

  const numeric = ds.columns.filter((c) => c.kind === "number" || c.kind === "boolean").map((c) => c.name);
  const [duckSums] = numeric.length
    ? await query(`SELECT ${numeric.map((c, i) => `sum(CAST(${ident(c)} AS DOUBLE)) AS s${i}`).join(", ")} FROM ${ident(ds.table)}`)
    : [{}];

  const problems: string[] = [];
  if (pandas.rows !== ds.rowCount) problems.push(`Row count differs: DuckDB ${ds.rowCount.toLocaleString()}, pandas ${pandas.rows.toLocaleString()}.`);
  const duckCols = ds.columns.map((c) => c.name);
  const missing = duckCols.filter((c) => !pandas.columns.includes(c));
  const extra = pandas.columns.filter((c) => !duckCols.includes(c));
  if (missing.length) problems.push(`Missing in pandas: ${missing.join(", ")}.`);
  if (extra.length) problems.push(`Extra in pandas: ${extra.join(", ")}.`);
  numeric.forEach((c, i) => {
    const a = duckSums[`s${i}`] as number | null;
    const b = pandas.sums[c];
    if (a === null || a === undefined || b === null || b === undefined) return;
    const tol = 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
    if (Math.abs(a - b) > tol) problems.push(`Total of ${c} differs: DuckDB ${a}, pandas ${b}.`);
  });

  return {
    ok: problems.length === 0,
    duck: { rows: ds.rowCount, columns: duckCols },
    pandas: { rows: pandas.rows, columns: pandas.columns },
    problems,
  };
}
