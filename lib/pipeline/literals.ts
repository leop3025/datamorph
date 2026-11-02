import type { ColumnInfo, ColumnKind } from "@/lib/data/types";
import { ident, lit } from "@/lib/duckdb/client";

// Helpers for writing values safely into both SQL and Python source.

/** Python string literal. JSON string syntax is valid Python. */
export const py = (s: string) => JSON.stringify(s);

export const pyList = (items: string[]) => `[${items.map(py).join(", ")}]`;

/** df["col"] */
export const pyCol = (df: string, name: string) => `${df}[${py(name)}]`;

export function kindOf(cols: ColumnInfo[], name: string): ColumnKind {
  return cols.find((c) => c.name === name)?.kind ?? "text";
}

export function toNumber(value: unknown): number {
  const n = Number(value);
  if (value === "" || value === null || value === undefined || !Number.isFinite(n))
    throw new Error(`"${value}" is not a number`);
  return n;
}

const truthy = (v: unknown) => ["true", "1", "yes", "y", "t"].includes(String(v).trim().toLowerCase());

/** A typed SQL literal for comparing against a column of this kind. */
export function sqlValue(value: unknown, kind: ColumnKind): string {
  if (kind === "number") return String(toNumber(value));
  if (kind === "boolean") return truthy(value) ? "true" : "false";
  if (kind === "date") return `TIMESTAMP ${lit(String(value))}`;
  return lit(String(value));
}

/** The matching Python literal. */
export function pyValue(value: unknown, kind: ColumnKind): string {
  if (kind === "number") return String(toNumber(value));
  if (kind === "boolean") return truthy(value) ? "True" : "False";
  if (kind === "date") return `pd.Timestamp(${py(String(value))})`;
  return py(String(value));
}

/** Comma-separated quoted identifiers. */
export const idents = (names: string[]) => names.map(ident).join(", ");

/** Explicit column list in current order, optionally renaming/replacing some columns. */
export function selectList(cols: ColumnInfo[], replace: Record<string, string> = {}) {
  return cols.map((c) => (c.name in replace ? replace[c.name] : ident(c.name))).join(", ");
}

export { ident, lit };
