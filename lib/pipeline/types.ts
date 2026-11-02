import type { ColumnInfo, ColumnKind, Dataset } from "@/lib/data/types";
import type { Row } from "@/lib/duckdb/client";

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Params = Record<string, any>;

export interface Step {
  id: string;
  type: string;
  enabled: boolean;
  params: Params;
}

export interface SqlContext {
  /** Quoted name of the table this step reads from */
  input: string;
  cols: ColumnInfo[];
  query: <T extends Row = Row>(sql: string) => Promise<T[]>;
  datasets: Dataset[];
}

export interface PyContext {
  /** Variable name of the DataFrame, usually df */
  df: string;
  cols: ColumnInfo[];
  /** Variable name for another dataset (used by joins) */
  dfName: (datasetId: string) => string;
  datasets: Dataset[];
}

export type FieldType =
  | "column"
  | "columns"
  | "select"
  | "multiselect"
  | "text"
  | "number"
  | "dataset"
  | "datasetColumn"
  | "aggs"
  | "edges"
  | "checkbox"
  | "sql";

export interface Field {
  key: string;
  label: string;
  type: FieldType;
  /** Restrict column pickers to these kinds */
  kinds?: ColumnKind[];
  options?: { value: string; label: string }[];
  placeholder?: string;
  help?: string;
  optional?: boolean;
  /** Hide the field unless this returns true */
  showIf?: (p: Params) => boolean;
  /** For datasetColumn: which param holds the dataset id */
  datasetKey?: string;
}

export interface StepDef {
  type: string;
  label: string;
  group: "clean" | "transform";
  description: string;
  fields: Field[];
  defaults: (cols: ColumnInfo[]) => Params;
  /** Return an error message if params are incomplete or invalid */
  validate: (p: Params, cols: ColumnInfo[]) => string | null;
  /** One-line, human-readable description of a configured step */
  summary: (p: Params, datasets: Dataset[]) => string;
  /** A SELECT statement producing the step's output from ctx.input */
  sql: (p: Params, ctx: SqlContext) => string | Promise<string>;
  /** pandas statements that apply the step to ctx.df */
  pandas: (p: Params, ctx: PyContext) => string[];
}
