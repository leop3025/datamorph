import { expect, test, type Locator, type Page } from "@playwright/test";

/** dnd-kit listens to pointer events, so drag with real mouse movements. */
async function drag(page: Page, from: Locator, to: Locator) {
  const a = (await from.boundingBox())!;
  const b = (await to.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 10, a.y + a.height / 2, { steps: 3 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 10 });
  await page.mouse.up();
}

test("chart builder: drag columns, auto-suggested chart, export", async ({ page }) => {
  await page.goto("/studio");
  await page.getByRole("button", { name: /Titanic/ }).click();
  await expect(page.getByText("Data quality score")).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "Visualise", exact: true }).click();

  // Default: first category × first number as a bar chart.
  await expect(page.getByRole("heading", { name: "Sum of survived by sex" })).toBeVisible();
  await expect(page.locator("canvas").first()).toBeVisible();

  // Drag two numbers onto X and Y → scatter is chosen automatically.
  const chip = (name: string) => page.locator("aside li button", { hasText: new RegExp(`^${name}`) }).first();
  await drag(page, chip("age"), page.locator('[data-shelf="x"]'));
  await drag(page, chip("fare"), page.locator('[data-shelf="y"]'));
  await expect(page.getByRole("heading", { name: "fare vs age" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Scatter/ })).toHaveClass(/border-accent/);

  // Colour by class.
  await drag(page, chip("class"), page.locator('[data-shelf="color"]'));
  await expect(page.locator('[data-shelf="color"]')).toContainText("class");
  await page.waitForTimeout(800);
  await page.screenshot({ path: "test-results/chart-scatter.png" });

  // Category on X + number on Y suggests a bar; box plot is also allowed.
  await drag(page, chip("class"), page.locator('[data-shelf="x"]'));
  await expect(page.getByRole("heading", { name: /fare by class/ })).toBeVisible();
  await page.getByRole("button", { name: "Box plot", exact: true }).click();
  await expect(page.getByRole("heading", { name: "fare by class", exact: true })).toBeVisible();
  await page.waitForTimeout(800);
  await page.screenshot({ path: "test-results/chart-box.png" });

  const png = page.waitForEvent("download");
  await page.getByRole("button", { name: "PNG" }).click();
  expect((await png).suggestedFilename()).toBe("fare_by_class.png");

  const svg = page.waitForEvent("download");
  await page.getByRole("button", { name: "SVG" }).click();
  expect((await svg).suggestedFilename()).toBe("fare_by_class.svg");

  await page.getByRole("button", { name: "Add to dashboard" }).click();
  await expect(page.getByRole("button", { name: "Added" })).toBeVisible();
});

test("line chart over time with date grain", async ({ page }) => {
  await page.goto("/studio");
  await page.getByRole("button", { name: /Chennai weather/ }).click();
  await expect(page.getByText("Data quality score")).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "Visualise", exact: true }).click();

  const chip = (name: string) => page.locator("aside li button", { hasText: new RegExp(`^${name}`) }).first();
  await chip("date").click(); // click-to-add fills X
  await drag(page, chip("max_temp_c"), page.locator('[data-shelf="y"]'));
  await expect(page.getByRole("button", { name: /Line/ }).first()).toHaveClass(/border-accent/);
  await page.locator('[data-shelf="y"] select').selectOption("mean");
  await expect(page.getByRole("heading", { name: "Average of max_temp_c by date" })).toBeVisible();
  await page.waitForTimeout(800);
  await page.screenshot({ path: "test-results/chart-line.png" });
});
