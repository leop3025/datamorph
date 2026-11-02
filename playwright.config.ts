import { defineConfig, devices } from "@playwright/test";

// Tests run against the production build on their own port, so they never clash with `npm run dev` on 3000.
const PORT = Number(process.env.E2E_PORT ?? 3100);

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  // Each test boots DuckDB (and often Python) in the page; too many at once starves the CPU.
  workers: process.env.CI ? 1 : 2,
  expect: { timeout: 15_000 },
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npm run start -- -p ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    // Never call a real AI provider from tests (the AI specs mock /api/ai or test the no-key path).
    // Empty values win over .env.local because Next.js doesn't override variables that are already set.
    env: { GROQ_API_KEY: "", GEMINI_API_KEY: "" },
  },
});
