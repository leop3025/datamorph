import { expect, test, type Page } from "@playwright/test";

test.setTimeout(420_000);

async function open(page: Page, sample: RegExp) {
  await page.goto("/studio");
  await page.getByRole("button", { name: sample }).click();
  await expect(page.getByText("Data quality score")).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "ML studio", exact: true }).click();
}

test("AutoML: leakage warning, leaderboard, what-if and code export", async ({ page }) => {
  await open(page, /Titanic/);
  await page.getByRole("button", { name: "Train models" }).click();
  await expect(page.getByTestId("ml-headline")).toBeVisible({ timeout: 300_000 });
  // "alive" is survived in words, so the model is suspiciously perfect.
  await expect(page.getByText(/Suspiciously perfect.*alive/)).toBeVisible();

  await page.getByRole("button", { name: "alive", exact: true }).click(); // deselect the leaky feature
  await page.getByRole("button", { name: "Train models" }).click();
  await expect(page.getByTestId("ml-headline")).toContainText(/predicts survived correctly (7|8)\d\.\d% of the time/, { timeout: 300_000 });
  await expect(page.getByText(/Suspiciously perfect/)).toHaveCount(0);
  await expect(page.locator("tbody tr")).toHaveCount(5);
  await expect(page.getByText(/ROC curve \(AUC 0\.(8|9)/)).toBeVisible();
  await expect(page.getByTestId("whatif")).toContainText(/Predicted survived\s*(0|1)/, { timeout: 30_000 });
  await page.screenshot({ path: "test-results/ml-automl.png", fullPage: true });

  await page.getByRole("button", { name: /Show scikit-learn code/ }).click();
  await expect(page.locator("pre code")).toContainText("cross_val_score(model, X, y, cv=cv");
});

test("clustering, PCA and anomalies", async ({ page }) => {
  await open(page, /Iris/);
  await page.getByRole("button", { name: "Clusters" }).click();
  await page.getByRole("button", { name: "Find clusters" }).click();
  await expect(page.getByTestId("cluster-headline")).toContainText(/[23] clusters \(silhouette 0\.\d+\)/, { timeout: 300_000 });
  await expect(page.getByText(/Cluster 1/).first()).toBeVisible();
  await page.screenshot({ path: "test-results/ml-clusters.png", fullPage: true });

  await page.getByRole("button", { name: "PCA / t-SNE" }).click();
  await page.getByRole("button", { name: "Run PCA" }).click();
  await expect(page.getByTestId("embed-headline")).toContainText(/keep 9\d% of the variance/, { timeout: 120_000 });

  await page.getByRole("button", { name: "Anomalies" }).click();
  await page.getByRole("button", { name: "Detect anomalies" }).click();
  await expect(page.getByTestId("anomaly-headline")).toContainText("of 150 rows flagged as unusual", { timeout: 120_000 });
  await expect(page.locator("tbody tr").first()).toBeVisible();
});

test("time series: monthly resample, decomposition and forecast", async ({ page }) => {
  await open(page, /Chennai weather/);
  await page.getByRole("button", { name: "Time series" }).click();
  await page.locator("section select").nth(1).selectOption("max_temp_c");
  await page.locator("section select").nth(3).selectOption("mean");
  await page.getByRole("button", { name: "Analyse & forecast" }).click();
  await expect(page.getByTestId("forecast-headline")).toContainText("Next 6 periods", { timeout: 300_000 });
  await expect(page.getByText(/Holt-Winters \(ETS, additive, seasonal, damped trend\)/)).toBeVisible();
  await expect(page.getByText("Decomposition")).toBeVisible();
  await page.waitForTimeout(800);
  await page.screenshot({ path: "test-results/forecast.png", fullPage: true });
});
