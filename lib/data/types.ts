import type { Step } from "@/lib/pipeline/types";

export type ColumnKind = "number" | "date" | "category" | "text" | "boolean";

export interface ColumnInfo {
  name: string;
  /** DuckDB physical type, e.g. DOUBLE, VARCHAR, DATE */
  duckType: string;
  kind: ColumnKind;
}

export type FileFormat = "csv" | "json" | "parquet" | "excel";

export interface DataSource {
  /** Original file name, e.g. titanic.csv */
  fileName: string;
  format: FileFormat;
  /** Set when loaded from a remote URL (used in exported code) */
  url?: string;
  /** Built-in sample served from /samples */
  sample?: boolean;
  /** Columns DuckDB parsed as dates on import (pandas needs parse_dates for these) */
  dateColumns: string[];
}

export interface Dataset {
  id: string;
  /** Display name, usually the file name */
  name: string;
  /** DuckDB table holding the current (recipe-applied) data */
  table: string;
  /** DuckDB table holding the untouched import */
  sourceTable: string;
  source: DataSource;
  rowCount: number;
  columns: ColumnInfo[];
  /** Cleaning / transform recipe, applied in order to the source table */
  steps: Step[];
  /** schemas[i] = columns before step i; schemas[steps.length] = final columns */
  schemas: ColumnInfo[][];
  /** Error message per failed step id (failed steps are skipped) */
  stepErrors: Record<string, string>;
  /** Manual category/text labels that don't change the stored type */
  kindOverrides: Record<string, ColumnKind>;
  /** Bumped whenever the underlying table changes, so views re-query */
  version: number;
}
