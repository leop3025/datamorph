import { expect, test, type Page } from "@playwright/test";

test.setTimeout(240_000);

async function runTest(page: Page, a: string, b: string) {
  const selects = page.locator("section").first().locator("select");
  await selects.nth(0).selectOption(a);
  await selects.nth(1).selectOption(b);
  await page.getByRole("button", { name: "Run test" }).click();
  await expect(page.getByTestId("headline")).toBeVisible({ timeout: 180_000 });
}

test("stats wizard picks the right test and explains it in plain English", async ({ page }) => {
  await page.goto("/studio");
  await page.getByRole("button", { name: /Titanic/ }).click();
  await expect(page.getByText("Data quality score")).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "Analyse", exact: true }).click();

  // Two categories → chi-square (first run also downloads Python).
  await runTest(page, "alive", "class");
  await expect(page.getByText("Chi-square test", { exact: true })).toBeVisible();
  await expect(page.getByTestId("headline")).toContainText("alive and class are related (p < 0.001)");
  await expect(page.getByText(/Cramér's V = 0\.34/)).toBeVisible();
  await page.screenshot({ path: "test-results/analyze-chi2.png" });

  // Number by a two-level category → Welch's t-test.
  await runTest(page, "fare", "sex");
  await expect(page.getByTestId("headline")).toContainText("Average fare differs significantly between");

  // Number alone → normality with a Q-Q plot.
  await runTest(page, "age", "");
  await expect(page.getByTestId("headline")).toContainText("age is not normally distributed");

  // Two numbers → correlation.
  await runTest(page, "age", "fare");
  await expect(page.getByTestId("headline")).toContainText(/relationship between age and fare|age and fare have a/);

  // Correlation matrix (Cramér's V over categories).
  await page.getByLabel("Method").selectOption("cramers_v");
  await page.getByRole("button", { name: "Compute" }).click();
  await expect(page.locator("section").last().locator("canvas").first()).toBeVisible({ timeout: 60_000 });
});
