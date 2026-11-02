import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// Benchmark (run with: PERF=1 npx playwright test e2e/perf.spec.ts). Generates a 1M-row CSV.
test.skip(!process.env.PERF, "Set PERF=1 to run the 1M-row benchmark");
test.setTimeout(600_000);

test("load and profile 1,000,000 rows", async ({ page }) => {
  const file = path.join(__dirname, "..", "test-results", "bench_1m.csv");
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const regions = ["North", "South", "East", "West"];
    const cats = ["Electronics", "Furniture", "Clothing", "Grocery"];
    const out = fs.createWriteStream(file);
    out.write("id,date,region,category,price,quantity,score\n");
    let seed = 1;
    const r = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    for (let i = 0; i < 1_000_000; i++) {
      const d = new Date(Date.UTC(2023, 0, 1) + Math.floor(r() * 730) * 86400000).toISOString().slice(0, 10);
      out.write(`${i},${d},${regions[i % 4]},${cats[Math.floor(r() * 4)]},${(r() * 500).toFixed(2)},${1 + Math.floor(r() * 9)},${r() < 0.05 ? "" : (r() * 100).toFixed(1)}\n`);
    }
    await new Promise((res) => out.end(res));
  }
  await page.goto("/studio");
  const t0 = Date.now();
  await page.locator('input[type="file"]').setInputFiles(file);
  await expect(page.getByText("Profiled in")).toBeVisible({ timeout: 300_000 });
  const total = Date.now() - t0;
  const profiled = await page.getByText("Profiled in").locator("..").innerText();
  console.log(`PERF upload+load+profile: ${(total / 1000).toFixed(2)} s | ${profiled.replace(/\n/g, " ")}`);
  await expect(page.getByText("1,000,000 × 7")).toBeVisible();

  // Scrolling deep into the virtualised table stays responsive.
  await page.getByRole("button", { name: "Data", exact: true }).click();
  const s0 = Date.now();
  await page.locator(".overflow-auto").first().evaluate((el) => (el.scrollTop = 32 * 900_000));
  await expect(page.getByText("900001", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  console.log(`PERF jump to row 900,001: ${Date.now() - s0} ms`);
});
