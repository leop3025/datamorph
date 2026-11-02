import { expect, test, type Page } from "@playwright/test";

async function loadSales(page: Page) {
  await page.goto("/studio");
  await page.getByRole("button", { name: /Retail sales/ }).click();
  await expect(page.getByText("Data quality score")).toBeVisible({ timeout: 60_000 });
}

const recipe = (page: Page) => page.locator("ol li");

test("profile quick-fixes become recipe steps, with undo/redo and code export", async ({ page }) => {
  await loadSales(page);

  // One-click fixes from the warnings list.
  await page.getByRole("button", { name: "Remove duplicates" }).click();
  await expect(page.getByText("Profiled in")).toBeVisible();
  await expect(page.getByText(/duplicate rows \(/)).toHaveCount(0, { timeout: 30_000 });
  await page.locator("li", { hasText: "customer_age has" }).getByRole("button", { name: "Fill with median" }).click();
  await expect(page.locator("li", { hasText: "customer_age has" })).toHaveCount(0, { timeout: 30_000 });
  await page.getByRole("button", { name: "Trim + lowercase" }).click();

  await page.getByRole("button", { name: "Clean", exact: true }).click();
  await expect(recipe(page)).toHaveCount(3);
  await expect(recipe(page).nth(0)).toContainText("Remove duplicate rows");
  await expect(page.getByText("5,000 × 10")).toBeVisible();

  // Undo / redo
  await page.getByRole("button", { name: "Undo (Ctrl+Z)" }).click();
  await expect(recipe(page)).toHaveCount(2);
  await page.getByRole("button", { name: "Redo (Ctrl+Y)" }).click();
  await expect(recipe(page)).toHaveCount(3);

  // Add a filter through the form.
  await page.getByRole("button", { name: /Filter rows/ }).click();
  await page.locator("form select").first().selectOption("quantity");
  await page.locator("form select").nth(1).selectOption("ge");
  await page.locator("form input").first().fill("5");
  await page.getByRole("button", { name: "Add step" }).click();
  await expect(recipe(page)).toHaveCount(4);
  await expect(page.getByText(/× 10$/).first()).not.toHaveText("5,000 × 10");

  await page.screenshot({ path: "test-results/clean-workspace.png" });

  // Generated code mirrors every step.
  await page.getByRole("button", { name: "Show me the code" }).click();
  await page.screenshot({ path: "test-results/code-dialog.png" });
  const code = page.locator("pre code");
  await expect(code).toContainText('df = pd.read_csv("sales.csv", parse_dates=["order_date"])');
  await expect(code).toContainText("df = df.drop_duplicates().reset_index(drop=True)");
  await expect(code).toContainText('df["customer_age"] = df["customer_age"].fillna(df["customer_age"].median())');
  await expect(code).toContainText('df["region"] = df["region"].str.strip().str.lower()');
  await expect(code).toContainText('df = df[df["quantity"] >= 5].reset_index(drop=True)');

  const nb = page.waitForEvent("download");
  await page.getByRole("button", { name: /Download notebook/ }).click();
  const file = await nb;
  expect(file.suggestedFilename()).toBe("sales_recipe.ipynb");
  const notebook = JSON.parse(await (await file.createReadStream()).toArray().then((c) => Buffer.concat(c).toString()));
  expect(notebook.nbformat).toBe(4);
  expect(notebook.cells.length).toBeGreaterThan(8);
});

test("transform: formula, group by and type change via table header", async ({ page }) => {
  await loadSales(page);
  await page.getByRole("button", { name: "Transform", exact: true }).click();

  await page.getByRole("button", { name: /Formula column/ }).click();
  await page.locator("form input").nth(0).fill("revenue");
  await page.locator("form input").nth(1).fill("unit_price * quantity * (1 - discount)");
  await page.getByRole("button", { name: "Add step" }).click();
  await expect(recipe(page)).toHaveCount(1);
  await expect(page.getByText("revenue", { exact: true }).first()).toBeVisible();

  await page.getByRole("button", { name: /Group & aggregate/ }).click();
  const form = page.locator("form");
  // by = region (default first category), aggregation = sum of revenue
  await form.locator("select").nth(2).selectOption("revenue");
  await page.getByRole("button", { name: "Add step" }).click();
  await expect(recipe(page)).toHaveCount(2);
  await expect(page.getByText("sum_revenue", { exact: true })).toBeVisible();

  // Formula errors are reported before adding.
  await page.getByRole("button", { name: /Formula column/ }).click();
  await page.locator("form input").nth(0).fill("bad");
  await page.locator("form input").nth(1).fill("nope * 2");
  await expect(page.getByText('Unknown column "nope"')).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();

  await page.getByRole("button", { name: "Show me the code" }).click();
  const code = page.locator("pre code");
  await expect(code).toContainText('df["revenue"] = ((df["unit_price"] * df["quantity"]) * (1 - df["discount"]))');
  await expect(code).toContainText('df.groupby(["region"], as_index=False, dropna=False).agg(**{"sum_revenue": ("revenue", "sum")})');
});
