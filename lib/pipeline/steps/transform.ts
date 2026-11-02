import type { StepDef } from "../types";
import { formulaToPandas, formulaToSql, parseFormula } from "../formula";
import { ident, idents, kindOf, lit, py, pyCol, pyList, toNumber } from "../literals";
import { validateSelect } from "@/lib/ai/sql";

const need = (v: unknown, msg: string) => (v === undefined || v === null || v === "" ? msg : null);
const firstOf = (cols: { name: string; kind: string }[], kinds: string[]) =>
  cols.find((c) => kinds.includes(c.kind))?.name ?? "";

// ---------- Group by ----------

export const AGG_FUNCS = [
  { value: "rows", label: "Count rows", sql: () => "count(*)", py: "size" },
  { value: "count", label: "Count values", sql: (c: string) => `count(${c})`, py: "count" },
  { value: "nunique", label: "Count distinct", sql: (c: string) => `count(DISTINCT ${c})`, py: "nunique" },
  { value: "sum", label: "Sum", sql: (c: string) => `sum(${c})`, py: "sum" },
  { value: "mean", label: "Mean", sql: (c: string) => `avg(${c})`, py: "mean" },
  { value: "median", label: "Median", sql: (c: string) => `median(${c})`, py: "median" },
  { value: "min", label: "Min", sql: (c: string) => `min(${c})`, py: "min" },
  { value: "max", label: "Max", sql: (c: string) => `max(${c})`, py: "max" },
  { value: "std", label: "Std dev", sql: (c: string) => `stddev_samp(${c})`, py: "std" },
];

export interface Agg {
  column: string;
  fn: string;
  as: string;
}

export const aggName = (a: Agg) => a.as?.trim() || (a.fn === "rows" ? "count" : `${a.fn}_${a.column}`);

const groupBy: StepDef = {
  type: "groupBy",
  label: "Group & aggregate",
  group: "transform",
  description: "Summarise rows per group, e.g. total sales per region.",
  fields: [
    { key: "by", label: "Group by", type: "columns" },
    { key: "aggs", label: "Aggregations", type: "aggs" },
  ],
  defaults: (cols) => ({
    by: [firstOf(cols, ["category"])].filter(Boolean),
    aggs: [{ column: firstOf(cols, ["number"]), fn: "sum", as: "" }],
  }),
  validate: (p, cols) => {
    if (!p.by.length) return "Choose at least one column to group by.";
    if (!p.aggs.length) return "Add at least one aggregation.";
    for (const a of p.aggs as Agg[]) {
      if (a.fn !== "rows" && !a.column) return "Choose a column for each aggregation.";
      if (["sum", "mean", "median", "std"].includes(a.fn) && kindOf(cols, a.column) !== "number")
        return `${a.fn} needs a numeric column (${a.column} isn't).`;
    }
    const names = (p.aggs as Agg[]).map(aggName).concat(p.by);
    if (new Set(names).size !== names.length) return "Output column names must be unique.";
    return null;
  },
  summary: (p) =>
    `Group by ${p.by.join(", ")}: ${(p.aggs as Agg[])
      .map((a) => (a.fn === "rows" ? "count rows" : `${a.fn}(${a.column})`))
      .join(", ")}`,
  sql: (p, { input }) => {
    const aggs = (p.aggs as Agg[]).map((a) => {
      const f = AGG_FUNCS.find((x) => x.value === a.fn)!;
      return `${f.sql(ident(a.column))} AS ${ident(aggName(a))}`;
    });
    return `SELECT ${idents(p.by)}, ${aggs.join(", ")} FROM ${input} GROUP BY ${idents(p.by)} ORDER BY ${idents(p.by)}`;
  },
  pandas: (p, { df }) => {
    const aggs = (p.aggs as Agg[]).map((a) => {
      const f = AGG_FUNCS.find((x) => x.value === a.fn)!;
      return `${py(aggName(a))}: (${py(a.fn === "rows" ? p.by[0] : a.column)}, ${py(f.py)})`;
    });
    return [`${df} = ${df}.groupby(${pyList(p.by)}, as_index=False, dropna=False).agg(**{${aggs.join(", ")}})`];
  },
};

// ---------- Pivot / unpivot ----------

const pivot: StepDef = {
  type: "pivot",
  label: "Pivot (long → wide)",
  group: "transform",
  description: "Turn the values of one column into new columns, e.g. one column per month.",
  fields: [
    { key: "index", label: "Rows", type: "columns" },
    { key: "columns", label: "New columns from", type: "column", kinds: ["category", "boolean", "number", "date"] },
    { key: "values", label: "Values", type: "column", kinds: ["number"] },
    {
      key: "fn",
      label: "Aggregate with",
      type: "select",
      options: AGG_FUNCS.filter((f) => ["sum", "mean", "median", "min", "max", "count"].includes(f.value)),
    },
  ],
  defaults: (cols) => ({
    index: [firstOf(cols, ["category"])].filter(Boolean),
    columns: cols.filter((c) => c.kind === "category")[1]?.name ?? "",
    values: firstOf(cols, ["number"]),
    fn: "sum",
  }),
  validate: (p) =>
    !p.index.length
      ? "Choose the row column(s)."
      : need(p.columns, "Choose the column whose values become new columns.") ??
        need(p.values, "Choose a numeric values column.") ??
        (p.index.includes(p.columns) ? "Rows and new columns must be different." : null),
  summary: (p) => `Pivot ${p.fn}(${p.values}) by ${p.index.join(", ")} × ${p.columns}`,
  sql: async (p, { input, query }) => {
    const c = ident(p.columns);
    const [{ n }] = await query<{ n: number }>(`SELECT count(DISTINCT ${c}) AS n FROM ${input}`);
    if (n > 100) throw new Error(`${p.columns} has ${n} distinct values; pivoting allows at most 100.`);
    const f = AGG_FUNCS.find((x) => x.value === p.fn)!;
    return `SELECT * FROM (
      PIVOT (SELECT ${idents(p.index)}, ${c}, ${ident(p.values)} FROM ${input} WHERE ${c} IS NOT NULL)
      ON ${c} USING ${f.sql(ident(p.values))} GROUP BY ${idents(p.index)}
    ) ORDER BY ${idents(p.index)}`;
  },
  // groupby + unstack rather than pivot_table: pivot_table drops rows whose keys are missing
  // (DuckDB keeps them), and its dropna=False would add every combination of key values.
  pandas: (p, { df }) => {
    const f = AGG_FUNCS.find((x) => x.value === p.fn)!;
    return [
      `${df} = (${df}[${pyCol(df, p.columns)}.notna()]`,
      `      .groupby(${pyList([...p.index, p.columns])}, dropna=False)[${py(p.values)}].agg(${py(f.py)})`,
      `      .unstack(${py(p.columns)}).reset_index())`,
      `${df}.columns = [str(c) for c in ${df}.columns]`,
    ];
  },
};

const unpivot: StepDef = {
  type: "unpivot",
  label: "Unpivot (wide → long)",
  group: "transform",
  description: "Stack several columns into name/value pairs, e.g. jan, feb, mar → month, sales.",
  fields: [
    { key: "columns", label: "Columns to stack", type: "columns", kinds: ["number"] },
    { key: "nameCol", label: "Name column", type: "text" },
    { key: "valueCol", label: "Value column", type: "text" },
  ],
  defaults: () => ({ columns: [], nameCol: "variable", valueCol: "value" }),
  validate: (p, cols) =>
    p.columns.length < 2
      ? "Choose at least two columns to stack."
      : need(p.nameCol, "Name the name column.") ??
        need(p.valueCol, "Name the value column.") ??
        (cols.some((c) => !p.columns.includes(c.name) && [p.nameCol, p.valueCol].includes(c.name))
          ? "Output names clash with an existing column."
          : null),
  summary: (p) => `Unpivot ${p.columns.join(", ")} → ${p.nameCol}, ${p.valueCol}`,
  // SQL-standard form: DuckDB's shorthand UNPIVOT doesn't accept INCLUDE NULLS inside CREATE TABLE AS.
  sql: (p, { input }) =>
    `SELECT * FROM ${input} UNPIVOT INCLUDE NULLS (${ident(p.valueCol)} FOR ${ident(p.nameCol)} IN (${idents(p.columns)}))`,
  pandas: (p, { df, cols }) => {
    const ids = cols.map((c) => c.name).filter((n) => !p.columns.includes(n));
    return [
      `${df} = ${df}.melt(id_vars=${pyList(ids)}, value_vars=${pyList(p.columns)}, var_name=${py(p.nameCol)}, value_name=${py(p.valueCol)})`,
    ];
  },
};

// ---------- Join ----------

const JOIN_HOW = [
  { value: "inner", label: "Inner: only matching rows" },
  { value: "left", label: "Left: keep all rows from this dataset" },
  { value: "right", label: "Right: keep all rows from the other" },
  { value: "outer", label: "Outer: keep everything" },
];

const join: StepDef = {
  type: "join",
  label: "Join another dataset",
  group: "transform",
  description: "Add columns from another dataset by matching a key column.",
  fields: [
    { key: "right", label: "Other dataset", type: "dataset" },
    { key: "leftOn", label: "Key in this dataset", type: "column" },
    { key: "rightOn", label: "Key in the other dataset", type: "datasetColumn", datasetKey: "right" },
    { key: "how", label: "Join type", type: "select", options: JOIN_HOW },
  ],
  defaults: (cols) => ({ right: "", leftOn: cols[0]?.name ?? "", rightOn: "", how: "left" }),
  validate: (p) =>
    need(p.right, "Choose a dataset to join.") ?? need(p.leftOn, "Choose a key column.") ?? need(p.rightOn, "Choose the other key column."),
  summary: (p, datasets) =>
    `${p.how[0].toUpperCase()}${p.how.slice(1)} join ${datasets.find((d) => d.id === p.right)?.name ?? "(missing dataset)"} on ${p.leftOn} = ${p.rightOn}`,
  sql: (p, { input, cols, datasets }) => {
    const right = datasets.find((d) => d.id === p.right);
    if (!right) throw new Error("The dataset to join was removed.");
    const sameKey = p.leftOn === p.rightOn;
    const leftNames = new Set(cols.map((c) => c.name));
    const select = cols.map((c) =>
      sameKey && c.name === p.leftOn && (p.how === "outer" || p.how === "right")
        ? `COALESCE(l.${ident(c.name)}, r.${ident(c.name)}) AS ${ident(c.name)}`
        : `l.${ident(c.name)}`,
    );
    for (const c of right.columns) {
      if (sameKey && c.name === p.rightOn) continue;
      const name = leftNames.has(c.name) ? `${c.name}_right` : c.name;
      select.push(`r.${ident(c.name)} AS ${ident(name)}`);
    }
    const how = { inner: "INNER", left: "LEFT", right: "RIGHT", outer: "FULL OUTER" }[p.how as string];
    return `SELECT ${select.join(", ")} FROM ${input} AS l ${how} JOIN ${ident(right.table)} AS r ON l.${ident(p.leftOn)} = r.${ident(p.rightOn)}`;
  },
  pandas: (p, { df, dfName }) => {
    const keys =
      p.leftOn === p.rightOn ? `on=${py(p.leftOn)}` : `left_on=${py(p.leftOn)}, right_on=${py(p.rightOn)}`;
    return [`${df} = ${df}.merge(${dfName(p.right)}, how=${py(p.how)}, ${keys}, suffixes=("", "_right"))`];
  },
};

// ---------- New columns ----------

const formula: StepDef = {
  type: "formula",
  label: "Formula column",
  group: "transform",
  description: "Create a column from an expression, e.g. revenue = unit_price * quantity.",
  fields: [
    { key: "name", label: "New column name", type: "text", placeholder: "revenue" },
    {
      key: "expr",
      label: "Formula",
      type: "text",
      placeholder: "unit_price * quantity * (1 - discount)",
      help: "Use + − * / ** %, comparisons, and/or/not, round() abs() sqrt() log() exp() if(cond, a, b). Wrap names with spaces in [brackets].",
    },
  ],
  defaults: () => ({ name: "", expr: "" }),
  validate: (p, cols) => {
    if (!String(p.name ?? "").trim()) return "Name the new column.";
    if (!String(p.expr ?? "").trim()) return "Enter a formula.";
    try {
      parseFormula(p.expr, cols.map((c) => c.name));
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  },
  summary: (p) => `${p.name} = ${p.expr}`,
  sql: (p, { input, cols }) => {
    const expr = formulaToSql(parseFormula(p.expr, cols.map((c) => c.name)));
    return cols.some((c) => c.name === p.name)
      ? `SELECT * REPLACE (${expr} AS ${ident(p.name)}) FROM ${input}`
      : `SELECT *, ${expr} AS ${ident(p.name)} FROM ${input}`;
  },
  pandas: (p, { df, cols }) => [
    `${pyCol(df, p.name)} = ${formulaToPandas(parseFormula(p.expr, cols.map((c) => c.name)), df)}`,
  ],
};

/** "0, 18, 35, 60" → [0, 18, 35, 60] */
export const parseEdges = (s: string) =>
  String(s ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map(toNumber);

const fmtEdge = (n: number) => (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(4))));

function binLabels(p: { edges: string; labels?: string }) {
  const edges = parseEdges(p.edges);
  const custom = String(p.labels ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  return custom.length ? custom : edges.slice(1).map((e, i) => `${fmtEdge(edges[i])}–${fmtEdge(e)}`);
}

const bin: StepDef = {
  type: "bin",
  label: "Bin into groups",
  group: "transform",
  description: "Turn a number into ranges, e.g. age → 0–18, 18–35, 35–60.",
  fields: [
    { key: "column", label: "Column", type: "column", kinds: ["number"] },
    { key: "edges", label: "Bin edges", type: "edges", help: "Comma-separated, ascending. Each bin includes its upper edge." },
    { key: "labels", label: "Labels", type: "text", optional: true, placeholder: "child, young adult, adult", help: "Optional, one per bin." },
    { key: "name", label: "New column name", type: "text" },
  ],
  defaults: (cols) => {
    const c = firstOf(cols, ["number"]);
    return { column: c, edges: "", labels: "", name: c ? `${c}_group` : "" };
  },
  validate: (p) => {
    const err = need(p.column, "Choose a numeric column.") ?? need(String(p.name ?? "").trim(), "Name the new column.");
    if (err) return err;
    let edges: number[];
    try {
      edges = parseEdges(p.edges);
    } catch (e) {
      return (e as Error).message;
    }
    if (edges.length < 2) return "Enter at least two edges.";
    if (edges.some((e, i) => i > 0 && e <= edges[i - 1])) return "Edges must be strictly increasing.";
    const labels = String(p.labels ?? "").split(",").filter((x) => x.trim());
    if (labels.length && labels.length !== edges.length - 1) return `Give ${edges.length - 1} labels, one per bin.`;
    return null;
  },
  summary: (p) => `Bin ${p.column} at ${p.edges} → ${p.name}`,
  sql: (p, { input }) => {
    const c = ident(p.column);
    const edges = parseEdges(p.edges);
    const labels = binLabels(p as { edges: string; labels?: string });
    const whens = edges.slice(1).map((e, i) => `WHEN ${c} <= ${e} THEN ${lit(labels[i])}`);
    return `SELECT *, CASE WHEN ${c} IS NULL OR ${c} < ${edges[0]} OR ${c} > ${edges[edges.length - 1]} THEN NULL ${whens.join(" ")} END AS ${ident(p.name)} FROM ${input}`;
  },
  pandas: (p, { df }) => {
    const edges = parseEdges(p.edges);
    const labels = binLabels(p as { edges: string; labels?: string });
    return [
      `${pyCol(df, p.name)} = pd.cut(${pyCol(df, p.column)}, bins=[${edges.join(", ")}], labels=${pyList(labels)}, include_lowest=True).astype("string")`,
    ];
  },
};

const DATE_PARTS = [
  { value: "year", label: "Year", sql: (c: string) => `year(${c})`, py: (c: string) => `${c}.dt.year` },
  { value: "quarter", label: "Quarter", sql: (c: string) => `quarter(${c})`, py: (c: string) => `${c}.dt.quarter` },
  { value: "month", label: "Month (1–12)", sql: (c: string) => `month(${c})`, py: (c: string) => `${c}.dt.month` },
  { value: "month_name", label: "Month name", sql: (c: string) => `monthname(${c})`, py: (c: string) => `${c}.dt.month_name()` },
  { value: "week", label: "ISO week", sql: (c: string) => `week(${c})`, py: (c: string) => `${c}.dt.isocalendar().week.astype("Int64")` },
  { value: "day", label: "Day of month", sql: (c: string) => `day(${c})`, py: (c: string) => `${c}.dt.day` },
  { value: "weekday", label: "Weekday name", sql: (c: string) => `dayname(${c})`, py: (c: string) => `${c}.dt.day_name()` },
  { value: "dayofweek", label: "Day of week (Mon=0)", sql: (c: string) => `isodow(${c}) - 1`, py: (c: string) => `${c}.dt.dayofweek` },
  { value: "hour", label: "Hour", sql: (c: string) => `hour(${c})`, py: (c: string) => `${c}.dt.hour` },
];

const dateParts: StepDef = {
  type: "dateParts",
  label: "Extract date parts",
  group: "transform",
  description: "Add year, month, weekday… columns from a date.",
  fields: [
    { key: "column", label: "Date column", type: "column", kinds: ["date"] },
    {
      key: "parts",
      label: "Parts",
      type: "multiselect",
      options: DATE_PARTS.map(({ value, label }) => ({ value, label })),
    },
  ],
  defaults: (cols) => ({ column: firstOf(cols, ["date"]), parts: ["year", "month", "weekday"] }),
  validate: (p, cols) =>
    need(p.column, "Choose a date column.") ??
    (kindOf(cols, p.column) !== "date" ? "Convert the column to a date first." : null) ??
    (!p.parts?.length ? "Pick at least one part." : null),
  summary: (p) => `Extract ${p.parts.join(", ")} from ${p.column}`,
  sql: (p, { input }) => {
    const c = ident(p.column);
    const parts = (p.parts as string[]).map((v) => {
      const d = DATE_PARTS.find((x) => x.value === v)!;
      return `${d.sql(c)} AS ${ident(`${p.column}_${v}`)}`;
    });
    return `SELECT *, ${parts.join(", ")} FROM ${input}`;
  },
  pandas: (p, { df }) =>
    (p.parts as string[]).map((v) => {
      const d = DATE_PARTS.find((x) => x.value === v)!;
      return `${pyCol(df, `${p.column}_${v}`)} = ${d.py(pyCol(df, p.column))}`;
    }),
};

// ---------- Encoding & scaling (feed into ML) ----------

const oneHot: StepDef = {
  type: "oneHot",
  label: "One-hot encode",
  group: "transform",
  description: "Replace a category column with 0/1 columns, one per value.",
  fields: [{ key: "column", label: "Column", type: "column", kinds: ["category", "boolean", "text"] }],
  defaults: (cols) => ({ column: firstOf(cols, ["category"]) }),
  validate: (p) => need(p.column, "Choose a column."),
  summary: (p) => `One-hot encode ${p.column}`,
  sql: async (p, { input, query }) => {
    const c = ident(p.column);
    const values = await query<{ v: string }>(
      `SELECT v FROM (SELECT DISTINCT CAST(${c} AS VARCHAR) AS v, ${c} AS o FROM ${input} WHERE ${c} IS NOT NULL) ORDER BY o LIMIT 51`,
    );
    if (values.length > 50) throw new Error(`${p.column} has more than 50 distinct values; one-hot encoding would create too many columns.`);
    const dummies = values.map(
      ({ v }) => `CASE WHEN CAST(${c} AS VARCHAR) = ${lit(v)} THEN 1 ELSE 0 END AS ${ident(`${p.column}_${v}`)}`,
    );
    return `SELECT * EXCLUDE (${c})${dummies.length ? ", " + dummies.join(", ") : ""} FROM ${input}`;
  },
  pandas: (p, { df }) => [`${df} = pd.get_dummies(${df}, columns=[${py(p.column)}], prefix=${py(p.column)}, dtype=int)`],
};

const labelEncode: StepDef = {
  type: "labelEncode",
  label: "Label encode",
  group: "transform",
  description: "Replace categories with integer codes (0, 1, 2… in sorted order; missing = −1).",
  fields: [{ key: "column", label: "Column", type: "column", kinds: ["category", "boolean", "text"] }],
  defaults: (cols) => ({ column: firstOf(cols, ["category"]) }),
  validate: (p) => need(p.column, "Choose a column."),
  summary: (p) => `Label encode ${p.column}`,
  sql: (p, { input }) => {
    const c = ident(p.column);
    return `SELECT * REPLACE (CASE WHEN ${c} IS NULL THEN -1 ELSE dense_rank() OVER (ORDER BY ${c}) - 1 END AS ${c}) FROM ${input} ORDER BY rowid`;
  },
  pandas: (p, { df }) => [`${pyCol(df, p.column)} = ${pyCol(df, p.column)}.astype("category").cat.codes`],
};

const scale: StepDef = {
  type: "scale",
  label: "Scale numbers",
  group: "transform",
  description: "Standardise (z-score) or rescale to 0–1 so features are comparable.",
  fields: [
    { key: "columns", label: "Columns", type: "columns", kinds: ["number"] },
    {
      key: "method",
      label: "Method",
      type: "select",
      options: [
        { value: "standard", label: "Standardise: (x − mean) / std" },
        { value: "minmax", label: "Min-max: (x − min) / (max − min)" },
      ],
    },
  ],
  defaults: () => ({ columns: [], method: "standard" }),
  validate: (p, cols) =>
    !p.columns.length
      ? "Choose at least one numeric column."
      : (p.columns as string[]).some((c) => kindOf(cols, c) !== "number")
        ? "Scaling needs numeric columns."
        : null,
  summary: (p) => `${p.method === "standard" ? "Standardise" : "Min-max scale"} ${p.columns.join(", ")}`,
  sql: (p, { input }) => {
    const parts = (p.columns as string[]).map((name) => {
      const c = ident(name);
      const s = (agg: string) => `(SELECT ${agg} FROM ${input})`;
      const expr =
        p.method === "standard"
          ? `(${c} - ${s(`avg(${c})`)}) / ${s(`stddev_samp(${c})`)}`
          : `(${c} - ${s(`min(${c})`)}) / (${s(`max(${c})`)} - ${s(`min(${c})`)})`;
      return `${expr} AS ${c}`;
    });
    return `SELECT * REPLACE (${parts.join(", ")}) FROM ${input}`;
  },
  pandas: (p, { df }) =>
    (p.columns as string[]).map((name) => {
      const c = pyCol(df, name);
      return p.method === "standard"
        ? `${c} = (${c} - ${c}.mean()) / ${c}.std()`
        : `${c} = (${c} - ${c}.min()) / (${c}.max() - ${c}.min())`;
    }),
};

const sort: StepDef = {
  type: "sort",
  label: "Sort rows",
  group: "transform",
  description: "Order rows by a column.",
  fields: [
    { key: "column", label: "Column", type: "column" },
    {
      key: "direction",
      label: "Direction",
      type: "select",
      options: [
        { value: "asc", label: "Ascending (A→Z, 0→9)" },
        { value: "desc", label: "Descending (Z→A, 9→0)" },
      ],
    },
  ],
  defaults: (cols) => ({ column: cols[0]?.name ?? "", direction: "asc" }),
  validate: (p) => need(p.column, "Choose a column."),
  summary: (p) => `Sort by ${p.column} ${p.direction === "asc" ? "ascending" : "descending"}`,
  sql: (p, { input }) =>
    `SELECT * FROM ${input} ORDER BY ${ident(p.column)} ${p.direction === "asc" ? "ASC" : "DESC"} NULLS LAST, rowid`,
  pandas: (p, { df }) => [
    `${df} = ${df}.sort_values(${py(p.column)}, ascending=${p.direction === "asc" ? "True" : "False"}, na_position="last", kind="stable").reset_index(drop=True)`,
  ],
};

// ---------- SQL query ----------

const PY_NAME = /^[A-Za-z_]\w*$/;

/** The step's input is visible to the query as `data`, and also under the dataset's own table name (`alias`). */
const sqlStep: StepDef = {
  type: "sql",
  label: "SQL query",
  group: "transform",
  description: "Reshape the data with a SELECT query. The current data is the table data.",
  fields: [
    {
      key: "query",
      label: "Query",
      type: "sql",
      placeholder: "SELECT region, sum(unit_price * quantity) AS revenue\nFROM data\nGROUP BY region",
      help: "Read-only SELECT. Exported Python runs it with the duckdb package (pip install duckdb).",
    },
  ],
  defaults: () => ({ query: "SELECT *\nFROM data", alias: "" }),
  validate: (p) => {
    const check = validateSelect(p.query ?? "", ["data", ...(p.alias ? [p.alias] : [])]);
    return check.ok ? null : check.reason!;
  },
  summary: (p) => `SQL: ${String(p.query).replace(/\s+/g, " ").slice(0, 60)}`,
  sql: (p, { input }) => {
    const user = validateSelect(p.query, ["data", ...(p.alias ? [p.alias] : [])]).sql;
    const ctes = [`data AS (SELECT * FROM ${input})`, ...(p.alias ? [`${ident(p.alias)} AS (SELECT * FROM ${input})`] : [])];
    const withUser = user.match(/^\s*with\s+(?!recursive\b)/i);
    return withUser
      ? `WITH ${ctes.join(", ")}, ${user.slice(withUser[0].length)}`
      : `WITH ${ctes.join(", ")} ${user}`;
  },
  pandas: (p, { df }) => [
    `data = ${df}`,
    ...(p.alias && PY_NAME.test(p.alias) && p.alias !== "data" ? [`${p.alias} = ${df}`] : []),
    `${df} = duckdb.sql(${py(validateSelect(p.query, []).sql)}).df()`,
  ],
};

export const TRANSFORM_STEPS: StepDef[] = [
  groupBy,
  pivot,
  unpivot,
  join,
  formula,
  bin,
  dateParts,
  oneHot,
  labelEncode,
  scale,
  sort,
  sqlStep,
];
