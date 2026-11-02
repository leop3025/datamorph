import { expect, test } from "@playwright/test";

test("autosave restores datasets, recipe and dashboard after a reload", async ({ page }) => {
  await page.goto("/studio");
  await page.getByRole("button", { name: /Retail sales/ }).click();
  await expect(page.getByText("Data quality score")).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "Remove duplicates" }).click();
  await expect(page.getByText("5,000 × 10")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Visualise", exact: true }).click();
  await page.getByRole("button", { name: "Add to dashboard" }).click();
  await page.waitForTimeout(2500); // autosave is debounced

  await page.reload();
  await expect(page.getByText("5,000 × 10")).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "Clean", exact: true }).click();
  await expect(page.locator("ol li")).toHaveCount(1);
  await page.getByRole("button", { name: "Dashboard", exact: true }).click();
  await expect(page.getByTestId("dashboard-grid").locator("canvas").first()).toBeVisible();
});

test("command palette runs actions by name; onboarding ticks itself; report opens", async ({ page }) => {
  await page.goto("/studio");
  await expect(page.getByTestId("onboarding")).toBeVisible();
  await page.keyboard.press("Control+k");
  await page.getByRole("textbox", { name: "Command" }).fill("sample titanic");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Data quality score")).toBeVisible({ timeout: 60_000 });

  await page.keyboard.press("Control+k");
  await page.getByRole("textbox", { name: "Command" }).fill("remove duplicate");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("onboarding")).toContainText("Fix an issue");
  await expect(page.getByTestId("onboarding").locator("li.line-through")).toHaveCount(3, { timeout: 30_000 });

  await page.keyboard.press("Control+k");
  await page.getByRole("textbox", { name: "Command" }).fill("filter rows");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Filter rows" })).toBeVisible();

  await page.getByRole("button", { name: "EDA report" }).click();
  await expect(page.getByTestId("report")).toContainText("Data quality:");
  await expect(page.getByTestId("report")).toContainText("Remove duplicate rows");
});
