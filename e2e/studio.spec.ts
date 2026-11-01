import { expect, test } from "@playwright/test";
import path from "node:path";

test("landing page links to the studio", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: /try with sample data/i }).click();
  await expect(page.getByRole("heading", { name: "Add a dataset" })).toBeVisible();
});

test("sample dataset → profile → data table", async ({ page }) => {
  await page.goto("/studio");
  await page.getByRole("button", { name: /Titanic/ }).click();

  // Profile tab opens automatically after loading.
  await expect(page.getByText("Data quality score")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/deck has .* missing values/)).toBeVisible();
  await expect(page.getByText("Correlation heatmap")).toBeVisible();
  await expect(page.getByRole("heading", { name: "age", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Data", exact: true }).click();
  await expect(page.getByText("Southampton").first()).toBeVisible();
  await page.screenshot({ path: "test-results/titanic-table.png" });
});

test("uploaded messy file shows duplicates and mixed-case warnings", async ({ page }) => {
  await page.goto("/studio");
  await page.locator('input[type="file"]').setInputFiles(path.join(__dirname, "..", "public/samples/sales.csv"));
  await expect(page.getByText("Data quality score")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/60 duplicate rows/)).toBeVisible();
  await expect(page.getByText(/order_id looks like an identifier/)).toBeVisible();
  await page.screenshot({ path: "test-results/sales-profile.png", fullPage: true });
});
