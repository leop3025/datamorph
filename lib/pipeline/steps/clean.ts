import type { StepDef } from "../types";
import {
  ident,
  idents,
  kindOf,
  lit,
  py,
  pyCol,
  pyList,
  pyValue,
  selectList,
  sqlValue,
  toNumber,
} from "../literals";

const need = (v: unknown, msg: string) => (v === undefined || v === null || v === "" ? msg : null);
const firstOf = (cols: { name: string; kind: string }[], kinds: string[]) =>
  cols.find((c) => kinds.includes(c.kind))?.name ?? "";

// ---------- Missing values ----------

const dropMissing: StepDef = {
  type: "dropMissing",
  label: "Drop rows with missing values",
  group: "clean",
  description: "Remove rows that have a missing value in the chosen columns (or in any column).",
  fields: [
    { key: "columns", label: "Columns", type: "columns", optional: true, help: "Leave empty to check every column." },
  ],
  defaults: () => ({ columns: [] }),
  validate: () => null,
  summary: (p) => (p.columns.length ? `Drop rows missing ${p.columns.join(", ")}` : "Drop rows with any missing value"),
  sql: (p, { input, cols }) => {
    const names: string[] = p.columns.length ? p.columns : cols.map((c) => c.name);
    return `SELECT * FROM ${input} WHERE ${names.map((n) => `${ident(n)} IS NOT NULL`).join(" AND ")}`;
  },
  pandas: (p, { df }) => [
    p.columns.length ? `${df} = ${df}.dropna(subset=${pyList(p.columns)})` : `${df} = ${df}.dropna()`,
  ],
};

const FILL_METHODS = [
  { value: "mean", label: "Mean" },
  { value: "median", label: "Median" },
  { value: "mode", label: "Most frequent (mode)" },
  { value: "constant", label: "A constant value" },
  { value: "ffill", label: "Previous value (forward fill)" },
  { value: "bfill", label: "Next value (backward fill)" },
];

const fillMissing: StepDef = {
  type: "fillMissing",
  label: "Fill missing values",
  group: "clean",
  description: "Replace missing values with a statistic, a constant, or a neighbouring value.",
  fields: [
    { key: "column", label: "Column", type: "column" },
    { key: "method", label: "Fill with", type: "select", options: FILL_METHODS },
    { key: "value", label: "Value", type: "text", showIf: (p) => p.method === "constant" },
  ],
  defaults: (cols) => ({ column: cols[0]?.name ?? "", method: "median", value: "" }),
  validate: (p, cols) => {
    const k = kindOf(cols, p.column);
    if (["mean", "median"].includes(p.method) && k !== "number") return "Mean and median need a numeric column.";
    if (p.method === "constant") {
      if (p.value === "") return "Enter a value.";
      if (k === "number" && !Number.isFinite(Number(p.value))) return "Enter a number for this numeric column.";
    }
    return need(p.column, "Choose a column.");
  },
  summary: (p) => {
    const how = p.method === "constant" ? `"${p.value}"` : FILL_METHODS.find((m) => m.value === p.method)?.label.toLowerCase();
    return `Fill missing ${p.column} with ${how}`;
  },
  sql: (p, { input, cols }) => {
    const c = ident(p.column);
    const expr: Record<string, string> = {
      mean: `COALESCE(${c}, (SELECT avg(${c}) FROM ${input}))`,
      median: `COALESCE(${c}, (SELECT median(${c}) FROM ${input}))`,
      mode: `COALESCE(${c}, (SELECT mode(${c}) FROM ${input}))`,
      constant: "", // built below only when chosen: an empty value would throw
      ffill: `last_value(${c} IGNORE NULLS) OVER (ORDER BY rowid ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)`,
      bfill: `first_value(${c} IGNORE NULLS) OVER (ORDER BY rowid ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING)`,
    };
    if (p.method === "constant") expr.constant = `COALESCE(${c}, ${sqlValue(p.value, kindOf(cols, p.column))})`;
    const ordered = p.method === "ffill" || p.method === "bfill";
    return `SELECT * REPLACE (${expr[p.method]} AS ${c}) FROM ${input}${ordered ? " ORDER BY rowid" : ""}`;
  },
  pandas: (p, { df, cols }) => {
    const c = pyCol(df, p.column);
    const rhs: Record<string, string> = {
      mean: `${c}.fillna(${c}.mean())`,
      median: `${c}.fillna(${c}.median())`,
      mode: `${c}.fillna(${c}.mode().iloc[0])`,
      constant: p.method === "constant" ? `${c}.fillna(${pyValue(p.value, kindOf(cols, p.column))})` : "",
      ffill: `${c}.ffill()`,
      bfill: `${c}.bfill()`,
    };
    return [`${c} = ${rhs[p.method]}`];
  },
};

// ---------- Duplicates ----------

const dropDuplicates: StepDef = {
  type: "dropDuplicates",
  label: "Remove duplicate rows",
  group: "clean",
  description: "Keep the first occurrence of each duplicated row.",
  fields: [
    {
      key: "columns",
      label: "Compare columns",
      type: "columns",
      optional: true,
      help: "Leave empty to compare whole rows.",
    },
  ],
  defaults: () => ({ columns: [] }),
  validate: () => null,
  summary: (p) => (p.columns.length ? `Remove duplicates by ${p.columns.join(", ")}` : "Remove duplicate rows"),
  sql: (p, { input, cols }) => {
    const keys: string[] = p.columns.length ? p.columns : cols.map((c) => c.name);
    return `SELECT * EXCLUDE (__rn, __rid) FROM (
      SELECT *, row_number() OVER (PARTITION BY ${idents(keys)} ORDER BY rowid) AS __rn, rowid AS __rid FROM ${input}
    ) WHERE __rn = 1 ORDER BY __rid`;
  },
  pandas: (p, { df }) => [
    p.columns.length
      ? `${df} = ${df}.drop_duplicates(subset=${pyList(p.columns)}).reset_index(drop=True)`
      : `${df} = ${df}.drop_duplicates().reset_index(drop=True)`,
  ],
};

// ---------- Outliers ----------

/** SQL for the lower and upper bounds, computed over the step input. */
function outlierBounds(method: string, c: string, input: string, k: number) {
  if (method === "zscore")
    return [
      `(SELECT avg(${c}) - ${k} * stddev_samp(${c}) FROM ${input})`,
      `(SELECT avg(${c}) + ${k} * stddev_samp(${c}) FROM ${input})`,
    ];
  const q1 = `quantile_cont(${c}, 0.25)`;
  const q3 = `quantile_cont(${c}, 0.75)`;
  return [`(SELECT ${q1} - ${k} * (${q3} - ${q1}) FROM ${input})`, `(SELECT ${q3} + ${k} * (${q3} - ${q1}) FROM ${input})`];
}

const outliers: StepDef = {
  type: "outliers",
  label: "Handle outliers",
  group: "clean",
  description: "Detect extreme values with the IQR rule or z-score, then cap, remove, or flag them.",
  fields: [
    { key: "column", label: "Column", type: "column", kinds: ["number"] },
    {
      key: "method",
      label: "Detect with",
      type: "select",
      options: [
        { value: "iqr", label: "IQR rule (Q1 − k·IQR, Q3 + k·IQR)" },
        { value: "zscore", label: "Z-score (mean ± k·std)" },
      ],
    },
    { key: "k", label: "Threshold k", type: "number", help: "Typical: 1.5 for IQR, 3 for z-score." },
    {
      key: "action",
      label: "Then",
      type: "select",
      options: [
        { value: "cap", label: "Cap to the bounds (winsorise)" },
        { value: "remove", label: "Remove those rows" },
        { value: "flag", label: "Flag in a new column" },
      ],
    },
  ],
  defaults: (cols) => ({ column: firstOf(cols, ["number"]), method: "iqr", k: 1.5, action: "cap" }),
  validate: (p, cols) =>
    need(p.column, "Choose a numeric column.") ??
    (kindOf(cols, p.column) !== "number" ? "Outlier handling needs a numeric column." : null) ??
    (!(Number(p.k) > 0) ? "Threshold must be a positive number." : null),
  summary: (p) => {
    const verb = { cap: "Cap", remove: "Remove", flag: "Flag" }[p.action as string];
    return `${verb} outliers in ${p.column} (${p.method === "iqr" ? "IQR" : "z-score"}, k=${p.k})`;
  },
  sql: (p, { input }) => {
    const c = ident(p.column);
    const [lo, hi] = outlierBounds(p.method, c, input, toNumber(p.k));
    if (p.action === "remove") return `SELECT * FROM ${input} WHERE ${c} IS NULL OR ${c} BETWEEN ${lo} AND ${hi}`;
    if (p.action === "flag")
      return `SELECT *, COALESCE(${c} NOT BETWEEN ${lo} AND ${hi}, false) AS ${ident(`${p.column}_outlier`)} FROM ${input}`;
    return `SELECT * REPLACE (CASE WHEN ${c} IS NULL THEN NULL WHEN ${c} < ${lo} THEN ${lo} WHEN ${c} > ${hi} THEN ${hi} ELSE ${c} END AS ${c}) FROM ${input}`;
  },
  pandas: (p, { df }) => {
    const c = pyCol(df, p.column);
    const k = toNumber(p.k);
    const bounds =
      p.method === "zscore"
        ? [`lo = ${c}.mean() - ${k} * ${c}.std()`, `hi = ${c}.mean() + ${k} * ${c}.std()`]
        : [`q1, q3 = ${c}.quantile(0.25), ${c}.quantile(0.75)`, `lo, hi = q1 - ${k} * (q3 - q1), q3 + ${k} * (q3 - q1)`];
    const action = {
      cap: `${c} = ${c}.clip(lower=lo, upper=hi)`,
      remove: `${df} = ${df}[${c}.isna() | ${c}.between(lo, hi)].reset_index(drop=True)`,
      flag: `${pyCol(df, `${p.column}_outlier`)} = ~${c}.between(lo, hi) & ${c}.notna()`,
    }[p.action as string]!;
    return [...bounds, action];
  },
};

// ---------- Types ----------

const TYPE_OPTIONS = [
  { value: "number", label: "Number (decimal)" },
  { value: "integer", label: "Whole number" },
  { value: "text", label: "Text" },
  { value: "date", label: "Date / time" },
  { value: "boolean", label: "Boolean (true/false)" },
];

const changeType: StepDef = {
  type: "changeType",
  label: "Change column type",
  group: "clean",
  description: "Convert a column. Values that can't be converted become missing.",
  fields: [
    { key: "column", label: "Column", type: "column" },
    { key: "to", label: "Convert to", type: "select", options: TYPE_OPTIONS },
    {
      key: "format",
      label: "Date format",
      type: "text",
      optional: true,
      placeholder: "%d/%m/%Y",
      help: "Optional. Leave empty to detect automatically.",
      showIf: (p) => p.to === "date",
    },
  ],
  defaults: (cols) => ({ column: cols[0]?.name ?? "", to: "number", format: "" }),
  validate: (p) => need(p.column, "Choose a column."),
  summary: (p) => `Convert ${p.column} to ${TYPE_OPTIONS.find((t) => t.value === p.to)?.label.toLowerCase()}`,
  sql: (p, { input }) => {
    const c = ident(p.column);
    const asText = `lower(trim(CAST(${c} AS VARCHAR)))`;
    const expr: Record<string, string> = {
      number: `TRY_CAST(${c} AS DOUBLE)`,
      integer: `TRY_CAST(TRY_CAST(${c} AS DOUBLE) AS BIGINT)`,
      text: `CAST(${c} AS VARCHAR)`,
      date: p.format
        ? `TRY_STRPTIME(CAST(${c} AS VARCHAR), ${lit(p.format)})`
        : `TRY_CAST(${c} AS TIMESTAMP)`,
      boolean: `CASE WHEN ${asText} IN ('true','t','yes','y','1') THEN true WHEN ${asText} IN ('false','f','no','n','0') THEN false END`,
    };
    return `SELECT * REPLACE (${expr[p.to]} AS ${c}) FROM ${input}`;
  },
  pandas: (p, { df }) => {
    const c = pyCol(df, p.column);
    const rhs: Record<string, string> = {
      number: `pd.to_numeric(${c}, errors="coerce")`,
      integer: `pd.to_numeric(${c}, errors="coerce").round().astype("Int64")`,
      text: `${c}.astype("string")`,
      date: p.format
        ? `pd.to_datetime(${c}, format=${py(p.format)}, errors="coerce")`
        : `pd.to_datetime(${c}, errors="coerce")`,
      boolean: `${c}.astype("string").str.strip().str.lower().map({"true": True, "t": True, "yes": True, "y": True, "1": True, "false": False, "f": False, "no": False, "n": False, "0": False})`,
    };
    return [`${c} = ${rhs[p.to]}`];
  },
};

// ---------- Text ----------

const TEXT_OPS = [
  { value: "trim", label: "Trim surrounding spaces" },
  { value: "lower", label: "lowercase" },
  { value: "upper", label: "UPPERCASE" },
  { value: "title", label: "Capitalise Each Word" },
  { value: "trimLower", label: "Trim + lowercase" },
];

const textClean: StepDef = {
  type: "textClean",
  label: "Clean text",
  group: "clean",
  description: "Trim spaces or change the case of a text column.",
  fields: [
    { key: "column", label: "Column", type: "column", kinds: ["category", "text"] },
    { key: "op", label: "Operation", type: "select", options: TEXT_OPS },
  ],
  defaults: (cols) => ({ column: firstOf(cols, ["category", "text"]), op: "trim" }),
  validate: (p, cols) =>
    need(p.column, "Choose a text column.") ??
    (!["category", "text"].includes(kindOf(cols, p.column)) ? "Choose a text column." : null),
  summary: (p) => `${TEXT_OPS.find((o) => o.value === p.op)?.label} in ${p.column}`,
  sql: (p, { input }) => {
    const c = ident(p.column);
    const expr: Record<string, string> = {
      trim: `trim(${c})`,
      lower: `lower(${c})`,
      upper: `upper(${c})`,
      title: `array_to_string(list_transform(string_split(lower(${c}), ' '), w -> upper(w[1:1]) || w[2:]), ' ')`,
      trimLower: `lower(trim(${c}))`,
    };
    return `SELECT * REPLACE (${expr[p.op]} AS ${c}) FROM ${input}`;
  },
  pandas: (p, { df }) => {
    const c = pyCol(df, p.column);
    const rhs: Record<string, string> = {
      trim: `${c}.str.strip()`,
      lower: `${c}.str.lower()`,
      upper: `${c}.str.upper()`,
      title: `${c}.map(lambda s: " ".join(w[:1].upper() + w[1:] for w in s.lower().split(" ")) if isinstance(s, str) else s)`,
      trimLower: `${c}.str.strip().str.lower()`,
    };
    return [`${c} = ${rhs[p.op]}`];
  },
};

const findReplace: StepDef = {
  type: "findReplace",
  label: "Find and replace",
  group: "clean",
  description: "Replace text inside a column, a whole cell value, or a regular-expression match.",
  fields: [
    { key: "column", label: "Column", type: "column", kinds: ["category", "text"] },
    { key: "find", label: "Find", type: "text" },
    { key: "replace", label: "Replace with", type: "text", optional: true },
    {
      key: "mode",
      label: "Match",
      type: "select",
      options: [
        { value: "substring", label: "Anywhere in the text" },
        { value: "whole", label: "Whole cell only" },
        { value: "regex", label: "Regular expression" },
      ],
    },
  ],
  defaults: (cols) => ({ column: firstOf(cols, ["category", "text"]), find: "", replace: "", mode: "substring" }),
  validate: (p, cols) =>
    need(p.column, "Choose a text column.") ??
    (!["category", "text"].includes(kindOf(cols, p.column)) ? "Choose a text column." : null) ??
    need(p.find, "Enter the text to find."),
  summary: (p) => `Replace "${p.find}" with "${p.replace ?? ""}" in ${p.column}`,
  sql: (p, { input }) => {
    const c = ident(p.column);
    const f = lit(p.find);
    const r = lit(p.replace ?? "");
    const expr: Record<string, string> = {
      substring: `replace(${c}, ${f}, ${r})`,
      whole: `CASE WHEN ${c} = ${f} THEN ${r} ELSE ${c} END`,
      regex: `regexp_replace(${c}, ${f}, ${r}, 'g')`,
    };
    return `SELECT * REPLACE (${expr[p.mode]} AS ${c}) FROM ${input}`;
  },
  pandas: (p, { df }) => {
    const c = pyCol(df, p.column);
    const rhs: Record<string, string> = {
      substring: `${c}.str.replace(${py(p.find)}, ${py(p.replace ?? "")}, regex=False)`,
      whole: `${c}.replace(${py(p.find)}, ${py(p.replace ?? "")})`,
      regex: `${c}.str.replace(${py(p.find)}, ${py(p.replace ?? "")}, regex=True)`,
    };
    return [`${c} = ${rhs[p.mode]}`];
  },
};

const splitColumn: StepDef = {
  type: "splitColumn",
  label: "Split column",
  group: "clean",
  description: "Split text on a delimiter into new columns (name_1, name_2, …).",
  fields: [
    { key: "column", label: "Column", type: "column", kinds: ["category", "text"] },
    { key: "delimiter", label: "Delimiter", type: "text", placeholder: "," },
    { key: "parts", label: "Number of parts", type: "number" },
  ],
  defaults: (cols) => ({ column: firstOf(cols, ["category", "text"]), delimiter: " ", parts: 2 }),
  validate: (p) =>
    need(p.column, "Choose a column.") ??
    need(p.delimiter, "Enter a delimiter.") ??
    (!(Number(p.parts) >= 2 && Number(p.parts) <= 20) ? "Parts must be between 2 and 20." : null),
  summary: (p) => `Split ${p.column} on "${p.delimiter}" into ${p.parts} columns`,
  sql: (p, { input }) => {
    const c = ident(p.column);
    const parts = Array.from({ length: Number(p.parts) }, (_, i) =>
      `string_split(${c}, ${lit(p.delimiter)})[${i + 1}] AS ${ident(`${p.column}_${i + 1}`)}`,
    );
    return `SELECT *, ${parts.join(", ")} FROM ${input}`;
  },
  pandas: (p, { df }) => {
    const c = pyCol(df, p.column);
    return [
      `_parts = ${c}.str.split(${py(p.delimiter)}, regex=False)`,
      ...Array.from(
        { length: Number(p.parts) },
        (_, i) => `${pyCol(df, `${p.column}_${i + 1}`)} = _parts.str[${i}]`,
      ),
    ];
  },
};

// ---------- Rows & columns ----------

export const FILTER_OPS = [
  { value: "eq", label: "equals" },
  { value: "ne", label: "does not equal" },
  { value: "gt", label: ">" },
  { value: "ge", label: "≥" },
  { value: "lt", label: "<" },
  { value: "le", label: "≤" },
  { value: "contains", label: "contains" },
  { value: "notContains", label: "does not contain" },
  { value: "startsWith", label: "starts with" },
  { value: "isNull", label: "is missing" },
  { value: "notNull", label: "is not missing" },
];

const noValue = (op: string) => op === "isNull" || op === "notNull";
const textOp = (op: string) => ["contains", "notContains", "startsWith"].includes(op);

const filter: StepDef = {
  type: "filter",
  label: "Filter rows",
  group: "clean",
  description: "Keep only the rows that match a condition.",
  fields: [
    { key: "column", label: "Column", type: "column" },
    { key: "op", label: "Condition", type: "select", options: FILTER_OPS },
    { key: "value", label: "Value", type: "text", showIf: (p) => !noValue(p.op) },
  ],
  defaults: (cols) => ({ column: cols[0]?.name ?? "", op: "eq", value: "" }),
  validate: (p, cols) => {
    const k = kindOf(cols, p.column);
    if (!noValue(p.op) && p.value === "") return "Enter a value.";
    if (["gt", "ge", "lt", "le"].includes(p.op) && !["number", "date"].includes(k))
      return "Use a number or date column for comparisons.";
    if (k === "number" && !noValue(p.op) && !textOp(p.op) && !Number.isFinite(Number(p.value)))
      return "Enter a number.";
    return need(p.column, "Choose a column.");
  },
  summary: (p) =>
    `Keep rows where ${p.column} ${FILTER_OPS.find((o) => o.value === p.op)?.label}${noValue(p.op) ? "" : ` ${p.value}`}`,
  sql: (p, { input, cols }) => {
    const c = ident(p.column);
    const v = () => sqlValue(p.value, kindOf(cols, p.column));
    const s = lit(String(p.value));
    const cond: Record<string, () => string> = {
      eq: () => `${c} = ${v()}`,
      ne: () => `${c} IS DISTINCT FROM ${v()}`,
      gt: () => `${c} > ${v()}`,
      ge: () => `${c} >= ${v()}`,
      lt: () => `${c} < ${v()}`,
      le: () => `${c} <= ${v()}`,
      contains: () => `contains(CAST(${c} AS VARCHAR), ${s})`,
      notContains: () => `NOT COALESCE(contains(CAST(${c} AS VARCHAR), ${s}), false)`,
      startsWith: () => `starts_with(CAST(${c} AS VARCHAR), ${s})`,
      isNull: () => `${c} IS NULL`,
      notNull: () => `${c} IS NOT NULL`,
    };
    return `SELECT * FROM ${input} WHERE ${cond[p.op]()}`;
  },
  pandas: (p, { df, cols }) => {
    const c = pyCol(df, p.column);
    const v = () => pyValue(p.value, kindOf(cols, p.column));
    const s = py(String(p.value));
    const cond: Record<string, () => string> = {
      eq: () => `${c} == ${v()}`,
      ne: () => `${c} != ${v()}`,
      gt: () => `${c} > ${v()}`,
      ge: () => `${c} >= ${v()}`,
      lt: () => `${c} < ${v()}`,
      le: () => `${c} <= ${v()}`,
      contains: () => `${c}.astype("string").str.contains(${s}, regex=False, na=False)`,
      notContains: () => `~${c}.astype("string").str.contains(${s}, regex=False, na=False)`,
      startsWith: () => `${c}.astype("string").str.startswith(${s}, na=False)`,
      isNull: () => `${c}.isna()`,
      notNull: () => `${c}.notna()`,
    };
    return [`${df} = ${df}[${cond[p.op]()}].reset_index(drop=True)`];
  },
};

const rename: StepDef = {
  type: "rename",
  label: "Rename column",
  group: "clean",
  description: "Give a column a new name.",
  fields: [
    { key: "column", label: "Column", type: "column" },
    { key: "to", label: "New name", type: "text" },
  ],
  defaults: (cols) => ({ column: cols[0]?.name ?? "", to: "" }),
  validate: (p, cols) =>
    need(p.column, "Choose a column.") ??
    need(String(p.to ?? "").trim(), "Enter a new name.") ??
    (cols.some((c) => c.name === p.to && c.name !== p.column) ? `A column named ${p.to} already exists.` : null),
  summary: (p) => `Rename ${p.column} → ${p.to}`,
  sql: (p, { input, cols }) =>
    `SELECT ${selectList(cols, { [p.column]: `${ident(p.column)} AS ${ident(p.to)}` })} FROM ${input}`,
  pandas: (p, { df }) => [`${df} = ${df}.rename(columns={${py(p.column)}: ${py(p.to)}})`],
};

const dropColumns: StepDef = {
  type: "dropColumns",
  label: "Drop columns",
  group: "clean",
  description: "Remove columns you don't need.",
  fields: [{ key: "columns", label: "Columns to drop", type: "columns" }],
  defaults: () => ({ columns: [] }),
  validate: (p, cols) =>
    !p.columns.length ? "Choose at least one column." : p.columns.length >= cols.length ? "You can't drop every column." : null,
  summary: (p) => `Drop ${p.columns.join(", ")}`,
  sql: (p, { input }) => `SELECT * EXCLUDE (${idents(p.columns)}) FROM ${input}`,
  pandas: (p, { df }) => [`${df} = ${df}.drop(columns=${pyList(p.columns)})`],
};

const selectColumns: StepDef = {
  type: "selectColumns",
  label: "Keep / reorder columns",
  group: "clean",
  description: "Keep only the chosen columns, in the order you pick them.",
  fields: [{ key: "columns", label: "Columns (in order)", type: "columns" }],
  defaults: (cols) => ({ columns: cols.map((c) => c.name) }),
  validate: (p) => (!p.columns.length ? "Choose at least one column." : null),
  summary: (p) => `Keep ${p.columns.length} columns: ${p.columns.slice(0, 4).join(", ")}${p.columns.length > 4 ? "…" : ""}`,
  sql: (p, { input }) => `SELECT ${idents(p.columns)} FROM ${input}`,
  pandas: (p, { df }) => [`${df} = ${df}[${pyList(p.columns)}]`],
};

export const CLEAN_STEPS: StepDef[] = [
  fillMissing,
  dropMissing,
  dropDuplicates,
  outliers,
  changeType,
  textClean,
  findReplace,
  splitColumn,
  filter,
  rename,
  dropColumns,
  selectColumns,
];
