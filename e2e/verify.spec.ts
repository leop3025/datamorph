import { expect, test, type Page } from "@playwright/test";

test.setTimeout(300_000);

type Step = { type: string; params: Record<string, unknown> };

async function load(page: Page, sample: RegExp) {
  await page.getByRole("button", { name: sample }).click();
  await expect(page.getByText("Data quality score")).toBeVisible({ timeout: 60_000 });
}

async function addSteps(page: Page, steps: Step[]) {
  await page.evaluate(async (steps) => {
    const store = (window as unknown as { __datamorph: { getState: () => { addStep: (t: string, p: unknown) => Promise<void> } } }).__datamorph;
    for (const s of steps) await store.getState().addStep(s.type, s.params);
  }, steps);
}

async function verify(page: Page) {
  await page.getByRole("button", { name: "Clean", exact: true }).click();
  await expect(page.locator("ol li .bg-bad-soft")).toHaveCount(0); // no failed steps
  await page.getByRole("button", { name: "Show me the code" }).click();
  await page.getByRole("button", { name: "Verify in Python" }).click();
  const bar = page.getByTestId("verify");
  await expect(bar).toContainText(/Verified|disagree|error/, { timeout: 240_000 });
  return bar;
}

test("cleaning + feature steps: generated pandas matches DuckDB", async ({ page }) => {
  await page.goto("/studio");
  await load(page, /Retail sales/);
  await addSteps(page, [
    { type: "dropDuplicates", params: { columns: [] } },
    { type: "fillMissing", params: { column: "customer_age", method: "median", value: "" } },
    { type: "fillMissing", params: { column: "rating", method: "ffill", value: "" } },
    { type: "textClean", params: { column: "region", op: "trimLower" } },
    { type: "textClean", params: { column: "category", op: "title" } },
    { type: "findReplace", params: { column: "channel", find: "Store", replace: "Shop", mode: "whole" } },
    { type: "outliers", params: { column: "unit_price", method: "iqr", k: 1.5, action: "cap" } },
    { type: "outliers", params: { column: "quantity", method: "zscore", k: 2, action: "flag" } },
    { type: "filter", params: { column: "discount", op: "le", value: "0.15" } },
    { type: "filter", params: { column: "region", op: "ne", value: "west" } },
    { type: "formula", params: { name: "revenue", expr: "round(unit_price * quantity * (1 - discount), 2)" } },
    { type: "formula", params: { name: "big_order", expr: "if(quantity >= 5 and revenue > 500, 1, 0)" } },
    { type: "bin", params: { column: "customer_age", edges: "18, 30, 45, 60, 80", labels: "", name: "age_group" } },
    { type: "dateParts", params: { column: "order_date", parts: ["year", "quarter", "month", "dayofweek"] } },
    { type: "splitColumn", params: { column: "order_id", delimiter: "-", parts: 2 } },
    { type: "oneHot", params: { column: "channel" } },
    { type: "labelEncode", params: { column: "category" } },
    { type: "scale", params: { columns: ["quantity"], method: "standard" } },
    { type: "changeType", params: { column: "rating", to: "integer", format: "" } },
    { type: "rename", params: { column: "unit_price", to: "price" } },
    { type: "dropColumns", params: { columns: ["order_id"] } },
    { type: "sort", params: { column: "revenue", direction: "desc" } },
  ]);
  const bar = await verify(page);
  await page.screenshot({ path: "test-results/verify-clean.png" });
  await expect(bar).toContainText("Verified");
});

test("group by, pivot, unpivot and join: generated pandas matches DuckDB", async ({ page }) => {
  await page.goto("/studio");
  await load(page, /Retail sales/);
  // A second dataset to join with, pasted as text.
  await page.getByRole("button", { name: "Add dataset" }).click();
  await page.getByRole("button", { name: /Paste data/ }).click();
  await page.locator("textarea").fill("region,manager,target\nNorth,Asha,120000\nSouth,Ravi,90000\nEast,Meena,100000\nWest,Arun,110000");
  await page.getByRole("button", { name: "Load pasted data" }).click();
  await expect(page.getByText("Data quality score")).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: /sales\.csv/ }).click();

  await addSteps(page, [
    { type: "textClean", params: { column: "region", op: "trim" } },
    { type: "findReplace", params: { column: "region", find: "^(\w)(\w*)$", replace: "\\1\\2", mode: "regex" } },
    { type: "join", params: { right: "pasted_data", leftOn: "region", rightOn: "region", how: "left" } },
    { type: "formula", params: { name: "revenue", expr: "unit_price * quantity" } },
    {
      type: "groupBy",
      params: {
        by: ["region", "manager", "category"],
        aggs: [
          { column: "revenue", fn: "sum", as: "" },
          { column: "", fn: "rows", as: "orders" },
          { column: "customer_age", fn: "mean", as: "avg_age" },
          { column: "channel", fn: "nunique", as: "" },
        ],
      },
    },
    { type: "pivot", params: { index: ["region", "manager"], columns: "category", values: "sum_revenue", fn: "sum" } },
    { type: "unpivot", params: { columns: ["Clothing", "Electronics", "Furniture", "Grocery"], nameCol: "category", valueCol: "revenue" } },
  ]);
  const bar = await verify(page);
  await page.screenshot({ path: "test-results/verify-transform.png" });
  await expect(bar).toContainText("Verified");
});
