import { expect, test, type Page } from "@playwright/test";

async function loadSales(page: Page) {
  await page.goto("/studio");
  await page.getByRole("button", { name: /Retail sales/ }).click();
  await expect(page.getByText("Data quality score")).toBeVisible({ timeout: 60_000 });
}

test("transform steps show what changed, and the Python code updates live", async ({ page }) => {
  await loadSales(page);
  await page.getByRole("button", { name: "Transform", exact: true }).click();

  await page.getByRole("button", { name: /Extract date parts/ }).click();
  await page.getByRole("button", { name: "Add step" }).click();
  await expect(page.getByTestId("last-change")).toContainText("added order_date_year, order_date_month, order_date_weekday");
  // The new columns are scrolled into view instead of hiding off to the right.
  await expect(page.getByTitle(/^order_date_year \(/)).toBeInViewport();

  await page.getByRole("button", { name: /Group & aggregate/ }).click();
  await page.getByRole("button", { name: "Add step" }).click();
  await expect(page.getByText("8 rows × 2 columns")).toBeVisible();
  // Float noise is trimmed for display (raw 347545.4000000006).
  await expect(page.getByText("347545.4", { exact: true })).toBeVisible();

  await page.getByRole("tab", { name: "Python code" }).click();
  const code = page.getByTestId("live-code");
  await expect(code).toContainText('df["order_date_year"] = df["order_date"].dt.year');
  await expect(code).toContainText('groupby(["region"]');
  await page.getByRole("button", { name: "Undo (Ctrl+Z)" }).click();
  await expect(code).not.toContainText("groupby");
});

test("Text to SQL: write or generate SQL, run it, and add it to the recipe", async ({ page }) => {
  await page.route("**/api/ai", (route) =>
    route.fulfill({ json: { sql: 'SELECT "region", sum("quantity") AS qty FROM "sales" GROUP BY 1 ORDER BY 1', explanation: "Units sold per region." } }),
  );
  await loadSales(page);
  await page.getByRole("button", { name: "Text to SQL" }).click();

  // Hand-written SQL
  const editor = page.getByRole("textbox", { name: "SQL", exact: true });
  await editor.fill("SELECT count(*) AS n FROM sales");
  await editor.press("Control+Enter");
  await expect(page.getByRole("cell", { name: "5,060" })).toBeVisible();

  // Write-only guardrail
  await editor.fill("DELETE FROM sales");
  await page.getByRole("button", { name: "Run" }).click();
  await expect(page.getByText("Only SELECT queries are allowed.")).toBeVisible();

  // Plain English → SQL
  await page.getByLabel("Question in plain English").fill("units per region");
  await page.getByRole("button", { name: "Write SQL" }).click();
  await expect(editor).toHaveValue(/sum\("quantity"\) AS qty/);
  await expect(page.getByText("Units sold per region.")).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "qty" })).toBeVisible();

  // Becomes a recipe step, exported as duckdb code
  await page.getByRole("button", { name: "Add to recipe" }).click();
  await expect(page.locator("ol li")).toContainText(["SQL: SELECT"]);
  await expect(page.getByText("8 rows × 2 columns")).toBeVisible();
  await page.getByRole("tab", { name: "Python code" }).click();
  const code = page.getByTestId("live-code");
  await expect(code).toContainText("import duckdb");
  await expect(code).toContainText("sales = df");
  await expect(code).toContainText('df = duckdb.sql("SELECT \\"region\\", sum(\\"quantity\\") AS qty');
});
