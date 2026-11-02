import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

// Covers the features the module-specific specs don't: every import format, data export,
// recipe controls, every chart type, ANOVA, regression + batch prediction, dashboard widget
// controls, theme, "start fresh" and the phone layout. Any uncaught page error fails the test.

test.setTimeout(420_000);

let pageErrors: string[] = [];
test.beforeEach(({ page }) => {
  pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
});
test.afterEach(() => expect(pageErrors, "uncaught page errors").toEqual([]));

async function load(page: Page, sample: RegExp) {
  await page.goto("/studio");
  await page.getByRole("button", { name: sample }).click();
  await expect(page.getByText("Data quality score")).toBeVisible({ timeout: 60_000 });
}

async function addSteps(page: Page, steps: { type: string; params: Record<string, unknown> }[]) {
  await page.evaluate(async (steps) => {
    const store = (window as unknown as { __datamorph: { getState: () => { addStep: (t: string, p: unknown) => Promise<void> } } }).__datamorph;
    for (const s of steps) await store.getState().addStep(s.type, s.params);
  }, steps);
}

const sidebarEntry = (page: Page, name: string) => page.locator("aside").first().getByRole("button", { name: new RegExp(`^${name.replace(".", "\\.")}`) });

test("export CSV / Parquet / Excel, then import each back (plus JSON)", async ({ page }) => {
  await load(page, /Retail sales/);
  await addSteps(page, [
    { type: "dropMissing", params: { columns: ["customer_age"] } },
    { type: "selectColumns", params: { columns: ["order_id", "region", "unit_price", "quantity", "customer_age"] } },
  ]);
  await page.getByRole("button", { name: "Clean", exact: true }).click();
  await expect(page.locator("ol li .bg-bad-soft")).toHaveCount(0);
  const shape = (await sidebarEntry(page, "sales.csv").innerText()).match(/[\d,]+ × 5/)![0];
  expect(shape).not.toBe("5,060 × 5"); // rows with missing age were dropped

  await page.getByRole("button", { name: "Show me the code" }).click();
  const files: Record<string, Buffer> = {};
  for (const f of ["CSV", "PARQUET", "XLSX"]) {
    const dl = page.waitForEvent("download");
    await page.getByRole("button", { name: f, exact: true }).click();
    const d = await dl;
    files[d.suggestedFilename()] = await readFile((await d.path())!);
  }
  expect(Object.keys(files).sort()).toEqual(["sales_clean.csv", "sales_clean.parquet", "sales_clean.xlsx"]);
  await page.getByRole("button", { name: "Close" }).click();

  files["people.json"] = Buffer.from(JSON.stringify([{ name: "Asha", age: 29 }, { name: "Ravi", age: 34 }, { name: "Meena", age: null }]));
  for (const [name, buffer] of Object.entries(files)) {
    await page.getByRole("button", { name: "Add dataset" }).click();
    await page.locator('input[type="file"]').setInputFiles({ name, mimeType: "application/octet-stream", buffer });
    await expect(page.getByText("Data quality score")).toBeVisible({ timeout: 60_000 });
    const entry = page.locator("aside").first().getByRole("button", { name: new RegExp(name.replace(/\./g, "\\.")) });
    await expect(entry).toContainText(name.endsWith(".json") ? "3 × 2" : shape);
  }
});

test("recipe controls: disable, enable, edit, delete, clear", async ({ page }) => {
  await load(page, /Retail sales/);
  await page.getByRole("button", { name: "Clean", exact: true }).click();
  await page.getByRole("button", { name: /Filter rows/ }).click();
  await page.locator("form select").first().selectOption("quantity");
  await page.locator("form select").nth(1).selectOption("ge");
  await page.locator("form input").first().fill("5");
  await page.getByRole("button", { name: "Add step" }).click();
  const rows = page.getByText(/^[\d,]+ rows × \d+ columns$/);
  await expect(rows).not.toHaveText(/^5,060 rows/);
  const filtered = await rows.textContent();

  await page.getByRole("button", { name: "Disable step" }).click();
  await expect(rows).toHaveText(/^5,060 rows/);
  await page.getByRole("button", { name: "Enable step" }).click();
  await expect(rows).toHaveText(filtered!);

  await page.getByRole("button", { name: "Edit step" }).click();
  await page.locator("form input").first().fill("9");
  await page.getByRole("button", { name: "Update step" }).click();
  await expect(page.locator("ol li")).toContainText("≥ 9");
  await expect(rows).not.toHaveText(filtered!);

  await page.getByRole("button", { name: "Delete step" }).click();
  await expect(page.locator("ol li")).toHaveCount(0);
  await expect(rows).toHaveText(/^5,060 rows/);

  await addSteps(page, [
    { type: "rename", params: { column: "region", to: "area" } },
    { type: "dropColumns", params: { columns: ["rating"] } },
  ]);
  await expect(page.locator("ol li")).toHaveCount(2);
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Clear all steps" }).click();
  await expect(page.locator("ol li")).toHaveCount(0);
  await expect(rows).toHaveText("5,060 rows × 10 columns");
});

test("every chart type renders without errors", async ({ page }) => {
  await load(page, /Retail sales/);
  await page.getByRole("button", { name: "Visualise", exact: true }).click();
  const types = ["Bar", "Line", "Area", "Scatter", "Histogram", "Box plot", "Heatmap", "Pie", "Treemap"];
  const rendered: string[] = [];
  for (const t of types) {
    // The suggested type's name is prefixed by its sparkle icon's label.
    const btn = page.getByRole("button", { name: new RegExp(`^(Suggested )?${t}$`) });
    if (await btn.isDisabled()) continue;
    await btn.click();
    await expect(btn).toHaveClass(/border-accent/);
    await expect(page.locator("canvas").first()).toBeVisible();
    await page.waitForTimeout(600);
    await page.screenshot({ path: `test-results/sweep-chart-${t.replace(" ", "-").toLowerCase()}.png` });
    rendered.push(t);
  }
  // With region × unit_price, at least these must be available.
  expect(rendered).toEqual(expect.arrayContaining(["Bar", "Box plot", "Pie", "Treemap"]));
});

test("ANOVA for a number across 3+ groups", async ({ page }) => {
  await load(page, /Titanic/);
  await page.getByRole("button", { name: "Analyse", exact: true }).click();
  const selects = page.locator("section").first().locator("select");
  await selects.nth(0).selectOption("fare");
  await selects.nth(1).selectOption("class");
  await page.getByRole("button", { name: "Run test" }).click();
  await expect(page.getByTestId("headline")).toBeVisible({ timeout: 180_000 });
  await expect(page.getByText(/ANOVA/).first()).toBeVisible();
  await expect(page.getByTestId("headline")).toContainText("fare");
});

test("AutoML regression and batch prediction download", async ({ page }) => {
  await load(page, /Titanic/);
  await page.getByRole("button", { name: "ML studio", exact: true }).click();
  const target = page.locator("label", { hasText: "Target (what to predict)" }).locator("select");
  await target.selectOption("fare");
  await page.getByRole("button", { name: "Train models" }).click();
  await expect(page.getByTestId("ml-headline")).toContainText(/explains -?\d+\.\d% of the variation in fare/, { timeout: 300_000 });
  const dl = page.waitForEvent("download");
  await page.getByRole("button", { name: /Download predictions/ }).click();
  const file = await dl;
  const csv = (await readFile((await file.path())!)).toString();
  expect(csv.split("\n")[0]).toMatch(/,prediction$/);
  expect(csv.trim().split("\n").length).toBe(892);
});

test("dashboard widgets: resize, taller, remove", async ({ page }) => {
  await load(page, /Retail sales/);
  await page.getByRole("button", { name: "Visualise", exact: true }).click();
  await page.getByRole("button", { name: "Add to dashboard" }).click();
  await page.getByRole("button", { name: "Dashboard", exact: true }).click();
  const grid = page.getByTestId("dashboard-grid");
  const widget = grid.locator("> *").first();
  await widget.hover();
  const before = (await widget.boundingBox())!;
  await widget.getByRole("button", { name: "Change width" }).click();
  await widget.getByRole("button", { name: "Taller" }).click();
  await expect.poll(async () => (await widget.boundingBox())!.height).toBeGreaterThan(before.height + 50);
  await widget.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText("Your dashboard is empty")).toBeVisible();
});

test("theme toggle and start fresh", async ({ page }) => {
  await load(page, /Retail sales/);
  const html = page.locator("html");
  const toggle = page.getByRole("button", { name: /^Theme:/ });
  const seen = new Set<string | null>();
  for (let i = 0; i < 3; i++) {
    await toggle.click();
    seen.add(await html.getAttribute("data-theme"));
  }
  expect(seen).toEqual(new Set(["light", "dark", null].filter((x) => seen.has(x))));
  expect([...seen].some((t) => t === "dark")).toBe(true);
  await page.screenshot({ path: "test-results/sweep-theme.png" });

  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Start fresh" }).click();
  await expect(page.getByRole("button", { name: /Retail sales/ })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: /Retail sales/ })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Data quality score")).toHaveCount(0);
});

test("phone layout: no sideways page scroll on any tab", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await load(page, /Retail sales/);
  for (const tab of ["Profile", "Data", "Clean", "Transform", "Visualise", "Analyse", "ML studio", "Ask AI", "Text to SQL", "Dashboard"]) {
    await page.getByRole("button", { name: tab, exact: true }).click();
    await page.waitForTimeout(400);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `${tab} overflows by ${overflow}px`).toBeLessThanOrEqual(1);
  }
});
