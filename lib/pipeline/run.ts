"use client";

import { exec, ident, query } from "@/lib/duckdb/client";
import { describeTable } from "@/lib/data/load";
import type { ColumnInfo, ColumnKind, Dataset } from "@/lib/data/types";
import { getStepDef } from "./registry";
import type { Step } from "./types";

export interface RunResult {
  rowCount: number;
  columns: ColumnInfo[];
  schemas: ColumnInfo[][];
  stepErrors: Record<string, string>;
}

function applyOverrides(cols: ColumnInfo[], overrides: Record<string, ColumnKind>): ColumnInfo[] {
  return cols.map((c) =>
    overrides[c.name] && c.duckType === "VARCHAR" ? { ...c, kind: overrides[c.name] } : c,
  );
}

/**
 * Rebuild the dataset's table by replaying its recipe on the untouched source table.
 * Each step materialises into a work table, so a failing step is skipped (and reported)
 * without breaking the steps after it.
 */
export async function runRecipe(ds: Dataset, steps: Step[], datasets: Dataset[]): Promise<RunResult> {
  const work = ident(`${ds.table}__work`);
  const next = ident(`${ds.table}__next`);
  await exec(`CREATE OR REPLACE TABLE ${work} AS SELECT * FROM ${ident(ds.sourceTable)}`);

  const describe = async () => {
    const d = await describeTable(`${ds.table}__work`);
    return { rowCount: d.rowCount, columns: applyOverrides(d.columns, ds.kindOverrides) };
  };

  let current = await describe();
  const schemas: ColumnInfo[][] = [];
  const stepErrors: Record<string, string> = {};

  for (const step of steps) {
    schemas.push(current.columns);
    if (!step.enabled) continue;
    const def = getStepDef(step.type);
    try {
      const invalid = def.validate(step.params, current.columns);
      if (invalid) throw new Error(invalid);
      const sql = await def.sql(step.params, { input: work, cols: current.columns, query, datasets });
      await exec(`CREATE OR REPLACE TABLE ${next} AS ${sql}`);
      await exec(`DROP TABLE ${work}`);
      await exec(`ALTER TABLE ${next} RENAME TO ${ident(`${ds.table}__work`)}`);
      current = await describe();
    } catch (e) {
      stepErrors[step.id] = cleanError((e as Error).message);
      await exec(`DROP TABLE IF EXISTS ${next}`);
    }
  }
  schemas.push(current.columns);

  await exec(`DROP TABLE IF EXISTS ${ident(ds.table)}`);
  await exec(`ALTER TABLE ${work} RENAME TO ${ident(ds.table)}`);
  return { rowCount: current.rowCount, columns: current.columns, schemas, stepErrors };
}

/** DuckDB errors include the full SQL; keep the first meaningful line. */
function cleanError(msg: string) {
  return msg.split("\n").find((l) => l.trim())?.replace(/^(Binder|Conversion|Catalog|Parser|Invalid Input) Error:\s*/, "") ?? msg;
}
