import { expect, test, type Page } from "@playwright/test";

async function loadSales(page: Page) {
  await page.goto("/studio");
  await page.getByRole("button", { name: /Retail sales/ }).click();
  await expect(page.getByText("Data quality score")).toBeVisible({ timeout: 60_000 });
}

test("without a key, the AI route explains how to configure it", async ({ page }) => {
  await loadSales(page);
  await page.getByRole("button", { name: "Ask AI", exact: true }).click();
  await page.getByLabel("Question").fill("total sales by region");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(page.getByText(/AI isn't configured/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Add a key" })).toBeVisible();
});

test("text-to-SQL: unsafe SQL is rejected, the retry runs locally, and only the schema is sent", async ({ page }) => {
  const sent: string[] = [];
  let calls = 0;
  await page.route("**/api/ai", async (route) => {
    const body = route.request().postDataJSON();
    sent.push(JSON.stringify(body));
    calls++;
    if (body.task === "sql") {
      // First answer tries to destroy data; the validator must refuse it and ask again.
      const sql =
        calls === 1
          ? 'DROP TABLE "sales"'
          : 'SELECT "region", round(sum("unit_price" * "quantity"), 2) AS revenue FROM "sales" GROUP BY 1 ORDER BY revenue DESC';
      return route.fulfill({ json: { sql, explanation: "Total revenue per region." } });
    }
    return route.fulfill({ json: { insights: [{ title: "North leads", detail: "North has the highest revenue." }] } });
  });

  await loadSales(page);
  await page.getByRole("button", { name: "Ask AI", exact: true }).click();
  await page.getByLabel("Question").fill("Which region has the most revenue?");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(page.getByText("Total revenue per region.")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("table tbody tr").first()).toBeVisible();
  expect(calls).toBe(2);
  expect(sent[1]).toContain("Only SELECT queries are allowed");

  // Editing the SQL by hand is validated too.
  await page.getByLabel("SQL").fill('DELETE FROM "sales"');
  await page.getByRole("button", { name: "Run" }).click();
  await expect(page.getByText(/Only SELECT queries are allowed/)).toBeVisible();

  await page.getByRole("button", { name: "Generate insights" }).click();
  await expect(page.getByTestId("insights")).toContainText("North leads");

  // Privacy: no raw order ids ever leave the browser (only schema + aggregates).
  expect(sent.join("\n")).not.toMatch(/ORD-\d{5}/);
});

test("dashboard: charts + KPI, global filter changes every widget", async ({ page }) => {
  await loadSales(page);
  await page.getByRole("button", { name: "Visualise", exact: true }).click();
  await page.getByRole("button", { name: "Add to dashboard" }).click();
  await page.getByRole("button", { name: "Pie", exact: true }).click();
  await page.getByRole("button", { name: "Add to dashboard" }).click();

  await page.getByRole("button", { name: "Dashboard", exact: true }).click();
  await page.getByRole("button", { name: "KPI card" }).click();
  await page.getByLabel("Aggregation").selectOption("count");
  await page.getByRole("button", { name: "Add", exact: true }).click();

  const grid = page.getByTestId("dashboard-grid");
  await expect(grid.locator("canvas").first()).toBeVisible();
  await expect(page.getByTestId("kpi-value")).toHaveText("5,060");

  // Global category filter
  await page.getByRole("button", { name: "+ Add filter" }).click();
  await page.getByLabel("Filter column").selectOption("channel");
  await page.getByRole("button", { name: /channel: all/ }).click();
  await page.getByRole("checkbox", { name: "Online" }).check();
  await expect(page.getByTestId("kpi-value")).not.toHaveText("5,060");
  const filtered = await page.getByTestId("kpi-value").textContent();
  expect(Number(filtered!.replace(/,/g, ""))).toBeLessThan(2500);
  await page.screenshot({ path: "test-results/dashboard.png" });

  const png = page.waitForEvent("download");
  await page.getByRole("button", { name: "PNG" }).click();
  expect((await png).suggestedFilename()).toBe("dashboard.png");
});
