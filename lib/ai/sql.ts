/**
 * Guardrail for AI-written SQL: it must be a single read-only SELECT over the user's own tables.
 * DuckDB can read files and URLs (read_csv, httpfs…), so those functions are refused too.
 */

const FORBIDDEN_KEYWORDS = [
  "insert", "update", "delete", "drop", "create", "alter", "attach", "detach", "copy", "export",
  "import", "install", "load", "pragma", "set", "reset", "call", "checkpoint", "vacuum", "truncate",
  "grant", "revoke", "begin", "commit", "rollback", "use",
];

const FORBIDDEN_FUNCTIONS = /\b(read_\w+|glob|sniff_csv|parquet_\w+|delta_scan|iceberg_\w+|query_table|getenv|duckdb_\w+|pragma_\w+|sqlite_\w+|postgres_\w+|mysql_\w+)\s*\(/i;

export interface SqlCheck {
  ok: boolean;
  sql: string;
  reason?: string;
}

/** Remove comments and string literals so keyword checks can't be fooled (or tripped) by them. */
function skeleton(sql: string) {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, "''");
}

export function validateSelect(raw: string, allowedTables: string[]): SqlCheck {
  let sql = raw.trim().replace(/^```(?:sql)?\s*/i, "").replace(/```$/, "").trim();
  sql = sql.replace(/;\s*$/, "");
  const bare = skeleton(sql);

  if (!sql) return { ok: false, sql, reason: "The query is empty." };
  if (bare.includes(";")) return { ok: false, sql, reason: "Only a single statement is allowed." };
  if (!/^\s*(select|with|from)\b/i.test(bare)) return { ok: false, sql, reason: "Only SELECT queries are allowed." };

  // Keywords only count outside of quoted identifiers ("Order Date" is fine).
  const words = bare.replace(/"(?:[^"]|"")*"/g, '""').toLowerCase().match(/[a-z_]+/g) ?? [];
  const bad = words.find((w) => FORBIDDEN_KEYWORDS.includes(w));
  if (bad) return { ok: false, sql, reason: `"${bad.toUpperCase()}" is not allowed in a read-only query.` };
  if (FORBIDDEN_FUNCTIONS.test(bare)) return { ok: false, sql, reason: "Reading files or system tables is not allowed." };
  if (/'(https?|s3|gcs|file):\/\//i.test(sql)) return { ok: false, sql, reason: "Queries can't access URLs." };

  // Every table after FROM/JOIN must be one of the user's datasets (or a CTE defined in the query).
  const ctes = [...bare.matchAll(/(?:with|,)\s*("?)(\w+)\1\s+as\s*\(/gi)].map((m) => m[2].toLowerCase());
  // EXTRACT(year FROM x), SUBSTRING(x FROM 2), TRIM(BOTH ' ' FROM x) use FROM without a table.
  const noFnFrom = bare.replace(/\b(extract|substring|trim|position|overlay)\s*\([^()]*\)/gi, "fn()");
  const refs = [...noFnFrom.matchAll(/\b(?:from|join)\s+("(?:[^"]|"")+"|[a-z_][\w.]*)/gi)].map((m) => m[1].replace(/^"|"$/g, "").toLowerCase());
  const allowed = new Set([...allowedTables.map((t) => t.toLowerCase()), ...ctes]);
  const unknown = refs.find((r) => !allowed.has(r) && r !== "(");
  if (unknown) return { ok: false, sql, reason: `Unknown table "${unknown}". Available: ${allowedTables.join(", ")}.` };

  return { ok: true, sql };
}
