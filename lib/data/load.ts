"use client";

import { exec, getDB, ident, lit, query } from "@/lib/duckdb/client";
import type { ColumnInfo, ColumnKind, FileFormat } from "./types";

export type { FileFormat };

export function detectFormat(fileName: string): FileFormat | null {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  if (["csv", "tsv", "txt"].includes(ext)) return "csv";
  if (["json", "ndjson", "jsonl"].includes(ext)) return "json";
  if (ext === "parquet") return "parquet";
  if (["xlsx", "xls"].includes(ext)) return "excel";
  return null;
}

/** "Sales Data (2024).csv" → "sales_data_2024" */
export function toTableName(fileName: string, taken: string[]): string {
  const base =
    fileName
      .replace(/\.[^.]+$/, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "data";
  const safe = /^[a-z_]/.test(base) ? base : `t_${base}`;
  let name = safe;
  for (let i = 2; taken.includes(name); i++) name = `${safe}_${i}`;
  return name;
}

/** Register bytes in DuckDB's virtual file system and create a table from them. */
export async function loadBytes(
  bytes: Uint8Array,
  fileName: string,
  format: FileFormat,
  table: string,
): Promise<void> {
  const db = await getDB();
  let path = `upload_${table}_${fileName}`;

  if (format === "excel") {
    // SheetJS is only downloaded when someone actually opens a spreadsheet.
    const XLSX = await import("xlsx");
    const wb = XLSX.read(bytes, { type: "array", cellDates: true });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const csv = XLSX.utils.sheet_to_csv(sheet, { dateNF: "yyyy-mm-dd" });
    path = `${path}.csv`;
    await db.registerFileText(path, csv);
    format = "csv";
  } else {
    await db.registerFileBuffer(path, bytes);
  }

  const reader = {
    csv: `read_csv_auto(${lit(path)}, sample_size = 20000)`,
    json: `read_json_auto(${lit(path)})`,
    parquet: `read_parquet(${lit(path)})`,
  }[format];

  await exec(`CREATE OR REPLACE TABLE ${ident(table)} AS SELECT * FROM ${reader}`);
  await db.dropFile(path);
}

export async function loadText(text: string, table: string) {
  await loadBytes(new TextEncoder().encode(text), "pasted.csv", "csv", table);
}

/** Turn a Google Sheets share link into its CSV export URL. */
export function normalizeUrl(url: string): string {
  const m = url.match(/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (m) {
    const gid = url.match(/[#&?]gid=(\d+)/)?.[1] ?? "0";
    return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv&gid=${gid}`;
  }
  return url;
}

export async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status} ${res.statusText})`);
  return new Uint8Array(await res.arrayBuffer());
}

// ---------- schema + type detection ----------

const NUMERIC = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|FLOAT|DOUBLE|DECIMAL|REAL)/;
const TEMPORAL = /^(DATE|TIMESTAMP|TIME)/;

export async function describeTable(table: string): Promise<{ rowCount: number; columns: ColumnInfo[] }> {
  const schema = await query<{ column_name: string; column_type: string }>(
    `DESCRIBE ${ident(table)}`,
  );
  const [{ n }] = await query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${ident(table)}`);

  // For text columns, the distinct ratio decides category vs free text.
  const textCols = schema.filter((c) => c.column_type === "VARCHAR").map((c) => c.column_name);
  const distinct: Record<string, number> = {};
  if (textCols.length && n > 0) {
    const sel = textCols.map((c, i) => `approx_count_distinct(${ident(c)}) AS d${i}`).join(", ");
    const [row] = await query(`SELECT ${sel} FROM ${ident(table)}`);
    textCols.forEach((c, i) => (distinct[c] = Number(row[`d${i}`])));
  }

  const columns = schema.map((c) => ({
    name: c.column_name,
    duckType: c.column_type,
    kind: inferKind(c.column_type, distinct[c.column_name], n),
  }));
  return { rowCount: n, columns };
}

export function inferKind(duckType: string, distinct: number | undefined, rows: number): ColumnKind {
  if (duckType === "BOOLEAN") return "boolean";
  if (NUMERIC.test(duckType)) return "number";
  if (TEMPORAL.test(duckType)) return "date";
  if (duckType === "VARCHAR") {
    const d = distinct ?? 0;
    return d <= Math.max(30, rows * 0.05) ? "category" : "text";
  }
  return "text";
}
