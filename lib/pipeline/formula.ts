import { ident, lit } from "@/lib/duckdb/client";
import { py, pyCol } from "./literals";

/**
 * A tiny, safe formula language for new columns, compiled to both SQL and pandas.
 *
 *   price * quantity * (1 - discount)
 *   round(log(fare + 1), 2)
 *   if(age < 18, "child", "adult")
 *   [unit price] > 100 and region == "South"
 *
 * Column names are bare identifiers or [bracketed names with spaces].
 * The parser builds an AST and both emitters fully parenthesise it, so operator
 * precedence is identical in SQL and pandas (where `&` binds tighter than `>`).
 */

type Node =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "bool"; v: boolean }
  | { t: "col"; v: string }
  | { t: "un"; op: "-" | "not"; a: Node }
  | { t: "bin"; op: string; a: Node; b: Node }
  | { t: "call"; fn: string; args: Node[] };

type Tok = { k: "num" | "str" | "id" | "col" | "op" | "eof"; v: string };

const FUNCS: Record<string, { n: number[]; sql: (a: string[]) => string; py: (a: string[]) => string }> = {
  round: {
    n: [1, 2],
    sql: (a) => `round(${a[0]}, ${a[1] ?? "0"})`,
    py: (a) => `np.round(${a[0]}, ${a[1] ?? "0"})`,
  },
  abs: { n: [1], sql: (a) => `abs(${a[0]})`, py: (a) => `np.abs(${a[0]})` },
  sqrt: { n: [1], sql: (a) => `sqrt(${a[0]})`, py: (a) => `np.sqrt(${a[0]})` },
  log: { n: [1], sql: (a) => `ln(${a[0]})`, py: (a) => `np.log(${a[0]})` },
  log10: { n: [1], sql: (a) => `log10(${a[0]})`, py: (a) => `np.log10(${a[0]})` },
  exp: { n: [1], sql: (a) => `exp(${a[0]})`, py: (a) => `np.exp(${a[0]})` },
  floor: { n: [1], sql: (a) => `floor(${a[0]})`, py: (a) => `np.floor(${a[0]})` },
  ceil: { n: [1], sql: (a) => `ceil(${a[0]})`, py: (a) => `np.ceil(${a[0]})` },
  if: {
    n: [3],
    sql: (a) => `(CASE WHEN ${a[0]} THEN ${a[1]} ELSE ${a[2]} END)`,
    py: (a) => `np.where(${a[0]}, ${a[1]}, ${a[2]})`,
  },
};

const OPS = ["==", "!=", ">=", "<=", "**", "+", "-", "*", "/", "%", ">", "<", "(", ")", ","];

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
    } else if (/[0-9.]/.test(ch)) {
      const m = src.slice(i).match(/^\d*\.?\d+(e[+-]?\d+)?/i)!;
      if (!m) throw new Error(`Unexpected "${ch}"`);
      out.push({ k: "num", v: m[0] });
      i += m[0].length;
    } else if (ch === '"' || ch === "'") {
      const end = src.indexOf(ch, i + 1);
      if (end < 0) throw new Error("Unclosed text value");
      out.push({ k: "str", v: src.slice(i + 1, end) });
      i = end + 1;
    } else if (ch === "[") {
      const end = src.indexOf("]", i);
      if (end < 0) throw new Error("Unclosed [column name]");
      out.push({ k: "col", v: src.slice(i + 1, end) });
      i = end + 1;
    } else if (/[A-Za-z_]/.test(ch)) {
      const m = src.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*/)!;
      out.push({ k: "id", v: m[0] });
      i += m[0].length;
    } else {
      const op = OPS.find((o) => src.startsWith(o, i));
      if (!op) throw new Error(`Unexpected "${ch}"`);
      out.push({ k: "op", v: op });
      i += op.length;
    }
  }
  out.push({ k: "eof", v: "" });
  return out;
}

// Binding powers, lowest first.
const BINARY: Record<string, number> = {
  or: 1,
  and: 2,
  "==": 4,
  "!=": 4,
  ">": 4,
  ">=": 4,
  "<": 4,
  "<=": 4,
  "+": 5,
  "-": 5,
  "*": 6,
  "/": 6,
  "%": 6,
  "**": 8,
};

export function parseFormula(src: string, columns: string[]): Node {
  const toks = tokenize(src);
  let pos = 0;
  const peek = () => toks[pos];
  const next = () => toks[pos++];
  const opOf = (t: Tok) => (t.k === "op" ? t.v : t.k === "id" && ["and", "or"].includes(t.v.toLowerCase()) ? t.v.toLowerCase() : null);

  function expr(minBp: number): Node {
    let left = prefix();
    for (;;) {
      const op = opOf(peek());
      if (!op || !(op in BINARY)) break;
      const bp = BINARY[op];
      if (bp < minBp) break;
      next();
      // ** is right-associative; everything else is left-associative.
      left = { t: "bin", op, a: left, b: expr(op === "**" ? bp : bp + 1) };
    }
    return left;
  }

  function prefix(): Node {
    const t = next();
    if (t.k === "num") return { t: "num", v: Number(t.v) };
    if (t.k === "str") return { t: "str", v: t.v };
    if (t.k === "col") return column(t.v);
    if (t.k === "op" && t.v === "-") return { t: "un", op: "-", a: expr(7) };
    if (t.k === "op" && t.v === "(") {
      const e = expr(0);
      expect(")");
      return e;
    }
    if (t.k === "id") {
      const low = t.v.toLowerCase();
      if (low === "not") return { t: "un", op: "not", a: expr(3) };
      if (low === "true" || low === "false") return { t: "bool", v: low === "true" };
      if (peek().v === "(" && low in FUNCS) {
        next();
        const args: Node[] = [];
        if (peek().v !== ")") {
          do args.push(expr(0));
          while (peek().v === "," && next());
        }
        expect(")");
        if (!FUNCS[low].n.includes(args.length))
          throw new Error(`${low}() takes ${FUNCS[low].n.join(" or ")} argument(s)`);
        return { t: "call", fn: low, args };
      }
      return column(t.v);
    }
    throw new Error(t.k === "eof" ? "Formula ends too early" : `Unexpected "${t.v}"`);
  }

  function column(name: string): Node {
    if (!columns.includes(name)) throw new Error(`Unknown column "${name}"`);
    return { t: "col", v: name };
  }

  function expect(v: string) {
    if (next().v !== v) throw new Error(`Expected "${v}"`);
  }

  const node = expr(0);
  if (peek().k !== "eof") throw new Error(`Unexpected "${peek().v}"`);
  return node;
}

const SQL_OP: Record<string, string> = { "==": "=", "!=": "<>", and: "AND", or: "OR", "**": "**" };
const PY_OP: Record<string, string> = { and: "&", or: "|" };

export function formulaToSql(n: Node): string {
  switch (n.t) {
    case "num":
      return String(n.v);
    case "str":
      return lit(n.v);
    case "bool":
      return n.v ? "true" : "false";
    case "col":
      return ident(n.v);
    case "un":
      return n.op === "-" ? `(-${formulaToSql(n.a)})` : `(NOT ${formulaToSql(n.a)})`;
    case "bin":
      // DuckDB's / is already floating-point division, like Python.
      return `(${formulaToSql(n.a)} ${SQL_OP[n.op] ?? n.op} ${formulaToSql(n.b)})`;
    case "call":
      return FUNCS[n.fn].sql(n.args.map(formulaToSql));
  }
}

export function formulaToPandas(n: Node, df: string): string {
  const go = (x: Node) => formulaToPandas(x, df);
  switch (n.t) {
    case "num":
      return String(n.v);
    case "str":
      return py(n.v);
    case "bool":
      return n.v ? "True" : "False";
    case "col":
      return pyCol(df, n.v);
    case "un":
      return n.op === "-" ? `(-${go(n.a)})` : `(~${go(n.a)})`;
    case "bin":
      return `(${go(n.a)} ${PY_OP[n.op] ?? n.op} ${go(n.b)})`;
    case "call":
      return FUNCS[n.fn].py(n.args.map(go));
  }
}

export const FORMULA_FUNCTIONS = Object.keys(FUNCS);
