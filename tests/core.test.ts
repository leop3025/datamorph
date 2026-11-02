import { describe, expect, it } from "vitest";
import { formulaToPandas, formulaToSql, parseFormula } from "@/lib/pipeline/formula";
import { validateSelect } from "@/lib/ai/sql";
import { recommend } from "@/lib/charts/builder";
import { scoreQuality, type ColumnProfile } from "@/lib/profile/profile";
import { getStepDef } from "@/lib/pipeline/registry";
import type { ColumnInfo } from "@/lib/data/types";

const cols = ["price", "quantity", "discount", "unit price", "region"];

describe("formula compiler", () => {
  it("keeps precedence identical in SQL and pandas", () => {
    const ast = parseFormula("price * quantity * (1 - discount)", cols);
    expect(formulaToSql(ast)).toBe('(("price" * "quantity") * (1 - "discount"))');
    expect(formulaToPandas(ast, "df")).toBe('((df["price"] * df["quantity"]) * (1 - df["discount"]))');
  });

  it("parenthesises boolean logic so pandas & doesn't bind tighter than >", () => {
    const ast = parseFormula('quantity > 5 and region == "South"', cols);
    expect(formulaToPandas(ast, "df")).toBe('((df["quantity"] > 5) & (df["region"] == "South"))');
    expect(formulaToSql(ast)).toBe(`(("quantity" > 5) AND ("region" = 'South'))`);
  });

  it("supports functions, bracketed names and right-associative powers", () => {
    expect(formulaToSql(parseFormula("round([unit price] * 2, 1)", cols))).toBe('round(("unit price" * 2), 1)');
    expect(formulaToPandas(parseFormula("if(price > 10, 1, 0)", cols), "df")).toBe('np.where((df["price"] > 10), 1, 0)');
    expect(formulaToSql(parseFormula("2 ** 3 ** 2", cols))).toBe("(2 ** (3 ** 2))");
    expect(formulaToSql(parseFormula("-price ** 2", cols))).toBe('(-("price" ** 2))');
  });

  it("rejects unknown columns, bad syntax and wrong argument counts", () => {
    expect(() => parseFormula("nope * 2", cols)).toThrow('Unknown column "nope"');
    expect(() => parseFormula("price *", cols)).toThrow("Formula ends too early");
    expect(() => parseFormula("abs(price, 2)", cols)).toThrow("abs() takes 1 argument(s)");
    expect(() => parseFormula("price; DROP TABLE x", cols)).toThrow();
  });
});

describe("AI SQL guardrail", () => {
  const tables = ["sales", "regions"];
  it("accepts read-only queries over known tables", () => {
    expect(validateSelect('SELECT "region", sum("price") FROM "sales" GROUP BY 1', tables).ok).toBe(true);
    expect(validateSelect("WITH t AS (SELECT * FROM sales) SELECT * FROM t JOIN regions USING (region);", tables).ok).toBe(true);
    expect(validateSelect('SELECT year(d), EXTRACT(month FROM "order_date") FROM sales', tables).ok).toBe(true);
    expect(validateSelect("```sql\nSELECT 1 FROM sales\n```", tables).ok).toBe(true);
  });
  it("rejects writes, multiple statements, file/URL access and unknown tables", () => {
    expect(validateSelect("DROP TABLE sales", tables).reason).toMatch(/Only SELECT/);
    expect(validateSelect("SELECT 1 FROM sales; DELETE FROM sales", tables).reason).toMatch(/single statement/);
    expect(validateSelect("SELECT * FROM read_csv('/etc/passwd')", tables).ok).toBe(false);
    expect(validateSelect("SELECT * FROM 'https://evil.example/x.parquet'", tables).ok).toBe(false);
    expect(validateSelect("SELECT * FROM secrets", tables).reason).toMatch(/Unknown table "secrets"/);
    expect(validateSelect("SELECT * FROM sales WHERE 1=1 /* ; DROP */", tables).ok).toBe(true);
  });
});

describe("chart recommendations", () => {
  it("matches column types to the right chart", () => {
    expect(recommend("category", "number")[0]).toBe("bar");
    expect(recommend("number", "number")[0]).toBe("scatter");
    expect(recommend("date", "number")[0]).toBe("line");
    expect(recommend("number", undefined)[0]).toBe("histogram");
    expect(recommend("category", "category")[0]).toBe("heatmap");
  });
});

describe("quality score", () => {
  const col = (p: Partial<ColumnProfile>): ColumnProfile => ({
    column: { name: "c", duckType: "DOUBLE", kind: "number" },
    missing: 0,
    missingPct: 0,
    unique: 100,
    outliers: 0,
    ...p,
  });
  it("is 100 for clean data and penalises problems", () => {
    expect(scoreQuality([col({})], 100, 0).score).toBe(100);
    const messy = scoreQuality([col({ missing: 10, missingPct: 0.1 })], 100, 5);
    expect(messy.score).toBe(100 - 16 - 12.5 > 0 ? Math.round(100 - 16 - 12.5) : 0);
  });
});

describe("step code generation", () => {
  const c: ColumnInfo[] = [
    { name: "age", duckType: "DOUBLE", kind: "number" },
    { name: "city", duckType: "VARCHAR", kind: "category" },
  ];
  const py = (type: string, params: Record<string, unknown>) =>
    getStepDef(type).pandas(params, { df: "df", cols: c, dfName: () => "df_other", datasets: [] }).join("\n");

  it("generates matching pandas for common steps", () => {
    expect(py("fillMissing", { column: "age", method: "median" })).toBe('df["age"] = df["age"].fillna(df["age"].median())');
    expect(py("filter", { column: "age", op: "ne", value: "30" })).toBe('df = df[df["age"] != 30].reset_index(drop=True)');
    expect(py("dropDuplicates", { columns: ["city"] })).toBe('df = df.drop_duplicates(subset=["city"]).reset_index(drop=True)');
    expect(py("oneHot", { column: "city" })).toBe('df = pd.get_dummies(df, columns=["city"], prefix="city", dtype=int)');
  });

  it("validates parameters before running", () => {
    expect(getStepDef("fillMissing").validate({ column: "city", method: "mean" }, c)).toMatch(/numeric/);
    expect(getStepDef("bin").validate({ column: "age", edges: "0, 18, 10", name: "g" }, c)).toMatch(/increasing/);
    expect(getStepDef("rename").validate({ column: "age", to: "city" }, c)).toMatch(/already exists/);
  });
});
