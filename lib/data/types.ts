export type ColumnKind = "number" | "date" | "category" | "text" | "boolean";

export interface ColumnInfo {
  name: string;
  /** DuckDB physical type, e.g. DOUBLE, VARCHAR, DATE */
  duckType: string;
  kind: ColumnKind;
}

export interface Dataset {
  id: string;
  /** Display name, usually the file name */
  name: string;
  /** DuckDB table name */
  table: string;
  rowCount: number;
  columns: ColumnInfo[];
  /** Bumped whenever the underlying table changes, so views re-query */
  version: number;
}
