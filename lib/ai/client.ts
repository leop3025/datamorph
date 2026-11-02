"use client";

import { ident, query } from "@/lib/duckdb/client";
import type { Dataset } from "@/lib/data/types";
import { validateSelect } from "./sql";

export type Provider = "groq" | "gemini";
export interface AISettings {
  provider: Provider;
  key: string;
}

const STORE = "datamorph.ai";

export function loadSettings(): AISettings {
  try {
    const raw = localStorage.getItem(STORE);
    if (raw) return JSON.parse(raw) as AISettings;
  } catch {}
  return { provider: "groq", key: "" };
}

export function saveSettings(s: AISettings) {
  try {
    localStorage.setItem(STORE, JSON.stringify(s));
  } catch {}
}

export class AIError extends Error {
  constructor(
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

async function callAI<T>(task: "sql" | "insights" | "explain", payload: unknown): Promise<T> {
  const s = loadSettings();
  const res = await fetch("/api/ai", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(s.key ? { "x-user-key": s.key, "x-provider": s.provider } : {}),
    },
    body: JSON.stringify({ task, payload }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new AIError(data.error ?? `AI request failed (${res.status}).`, data.code);
  return data as T;
}

/**
 * What the model is allowed to see: table and column names, types, row counts and summary
 * statistics (ranges, most common category values). Never raw rows.
 */
export async function schemaContext(datasets: Dataset[]) {
  return Promise.all(
    datasets.map(async (ds) => {
      const T = ident(ds.table);
      const columns = await Promise.all(
        ds.columns.map(async (c) => {
          const col = ident(c.name);
          const info: Record<string, unknown> = { name: c.name, type: c.duckType, kind: c.kind };
          if (c.kind === "number" || c.kind === "date") {
            const [r] = await query(`SELECT CAST(min(${col}) AS VARCHAR) AS lo, CAST(max(${col}) AS VARCHAR) AS hi FROM ${T}`);
            info.range = [r.lo, r.hi];
          } else if (c.kind === "category" || c.kind === "boolean") {
            const top = await query<{ v: string }>(`SELECT CAST(${col} AS VARCHAR) AS v FROM ${T} WHERE ${col} IS NOT NULL GROUP BY 1 ORDER BY count(*) DESC LIMIT 12`);
            info.values = top.map((t) => t.v);
          }
          return info;
        }),
      );
      return { table: ds.table, name: ds.name, rows: ds.rowCount, columns };
    }),
  );
}

export interface SqlAnswer {
  sql: string;
  explanation: string;
  columns: string[];
  rows: Record<string, unknown>[];
  attempts: number;
}

const MAX_ROWS = 1000;

/** Run SQL that already passed validation, capped so a huge result can't freeze the page. */
export async function runSafeSelect(sql: string, datasets: Dataset[]) {
  const check = validateSelect(sql, datasets.map((d) => d.table));
  if (!check.ok) throw new AIError(check.reason!);
  const rows = await query(`SELECT * FROM (${check.sql}) AS q LIMIT ${MAX_ROWS}`);
  return { sql: check.sql, rows, columns: rows.length ? Object.keys(rows[0]) : [] };
}

/** Question → SQL (from the LLM) → validate → run locally; one retry with the error message. */
export async function askQuestion(question: string, active: Dataset, datasets: Dataset[]): Promise<SqlAnswer> {
  const schema = await schemaContext([active, ...datasets.filter((d) => d.id !== active.id)]);
  let feedback: { sql: string; error: string } | undefined;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const out = await callAI<{ sql?: string; explanation?: string }>("sql", {
      question,
      main_table: active.table,
      schema,
      ...(feedback ? { previous_attempt: feedback, instruction: "The previous SQL failed. Fix it." } : {}),
    });
    try {
      const res = await runSafeSelect(out.sql ?? "", datasets);
      return { ...res, explanation: out.explanation ?? "", attempts: attempt };
    } catch (e) {
      feedback = { sql: out.sql ?? "", error: (e as Error).message.split("\n")[0] };
      if (attempt === 2) throw new AIError(`Couldn't produce a working query: ${feedback.error}`);
    }
  }
  throw new AIError("Unreachable");
}

export interface Insight {
  title: string;
  detail: string;
}

/** Compute candidate facts locally (aggregates only), then let the model pick and phrase the best. */
export async function autoInsights(ds: Dataset): Promise<Insight[]> {
  const T = ident(ds.table);
  const nums = ds.columns.filter((c) => c.kind === "number" && !/(^|_)id$/i.test(c.name)).slice(0, 6);
  const cats = ds.columns.filter((c) => c.kind === "category" || c.kind === "boolean").slice(0, 4);
  const date = ds.columns.find((c) => c.kind === "date");
  const facts: Record<string, unknown> = { dataset: ds.name, rows: ds.rowCount };

  if (nums.length) {
    const sel = nums.map((c, i) => `avg(${ident(c.name)})::DOUBLE AS a${i}, min(${ident(c.name)})::DOUBLE AS lo${i}, max(${ident(c.name)})::DOUBLE AS hi${i}, (count(*) - count(${ident(c.name)}))::DOUBLE / count(*) AS m${i}`);
    const [r] = await query(`SELECT ${sel.join(", ")} FROM ${T}`);
    facts.numeric = nums.map((c, i) => ({ column: c.name, mean: r[`a${i}`], min: r[`lo${i}`], max: r[`hi${i}`], missing_share: r[`m${i}`] }));
  }
  const measure = nums[0];
  facts.by_group = await Promise.all(
    cats.map(async (c) => ({
      group_by: c.name,
      measure: measure ? `sum(${measure.name})` : "rows",
      top: await query(
        `SELECT CAST(${ident(c.name)} AS VARCHAR) AS value, ${measure ? `sum(${ident(measure.name)})::DOUBLE` : "count(*)"} AS total, count(*) AS rows
         FROM ${T} GROUP BY 1 ORDER BY 2 DESC NULLS LAST LIMIT 6`,
      ),
    })),
  );
  if (date && measure) {
    facts.monthly = await query(
      `SELECT strftime(date_trunc('month', ${ident(date.name)}), '%Y-%m') AS month, sum(${ident(measure.name)})::DOUBLE AS total
       FROM ${T} WHERE ${ident(date.name)} IS NOT NULL GROUP BY 1 ORDER BY 1 DESC LIMIT 24`,
    );
    if (cats[0])
      facts.monthly_by_group = await query(
        `SELECT strftime(date_trunc('month', ${ident(date.name)}), '%Y-%m') AS month, CAST(${ident(cats[0].name)} AS VARCHAR) AS grp, sum(${ident(measure.name)})::DOUBLE AS total
         FROM ${T} WHERE ${ident(date.name)} >= (SELECT max(${ident(date.name)}) - INTERVAL 6 MONTH FROM ${T}) GROUP BY 1, 2 ORDER BY 1, 2`,
      );
  }
  if (nums.length >= 2) {
    const pairs: string[] = [];
    for (let i = 0; i < nums.length; i++) for (let j = i + 1; j < nums.length; j++) pairs.push(`corr(${ident(nums[i].name)}, ${ident(nums[j].name)}) AS "${nums[i].name} ~ ${nums[j].name}"`);
    const [r] = await query(`SELECT ${pairs.join(", ")} FROM ${T}`);
    facts.correlations = Object.entries(r)
      .filter(([, v]) => v !== null)
      .sort((a, b) => Math.abs(Number(b[1])) - Math.abs(Number(a[1])))
      .slice(0, 4);
  }
  const out = await callAI<{ insights?: Insight[] }>("insights", facts);
  return out.insights ?? [];
}

export async function explainChart(title: string, summary: unknown): Promise<string> {
  const out = await callAI<{ explanation?: string }>("explain", { title, data: summary });
  return out.explanation ?? "";
}
