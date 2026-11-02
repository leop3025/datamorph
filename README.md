# Datamorph

**A no-code data analysis and ML studio that runs entirely in your browser.** Drop in a CSV, Excel, JSON or Parquet file, then profile, clean, transform, visualise, test, model and build dashboards with clicks, and Datamorph writes the pandas code for everything you did.

> Live demo: _add your Vercel link here_

## Why browser-first?

All data processing happens on the visitor's machine:

- **Privacy:** your data is never uploaded. The AI assistant only ever sees column names and summary statistics.
- **Speed:** DuckDB-WASM is a columnar SQL engine; Python (pandas, scikit-learn, SciPy, statsmodels) runs via Pyodide.
- **Free hosting:** the server only serves static files plus one small AI route, so there's no compute bill.

```
Browser
├── Next.js UI (React 19, Tailwind, dnd-kit, ECharts)
├── DuckDB-WASM (Web Worker)   → import, profiling, recipes, charts, SQL
├── Pyodide (Web Worker, lazy) → stats tests, AutoML, clustering, forecasting, code verification
└── IndexedDB                  → project autosave (source tables as Parquet + recipes)
Vercel
├── Static hosting
└── /api/ai → Groq or Gemini (schema + aggregates only, rate-limited)
```

## Features

| Module | What you can do |
|---|---|
| **Import** | CSV/TSV, JSON/NDJSON, Excel, Parquet, URL, public Google Sheet, pasted data · 4 sample datasets · type detection with manual override |
| **Profile** | Per-column stats & histograms, data quality score (0–100), plain-English warnings with **one-click fixes**, correlation heatmap |
| **Clean** | Fill/drop missing, remove duplicates, outliers (IQR / z-score: cap, remove, flag), change type, clean text, find & replace, split, filter, rename, drop/reorder |
| **Transform** | Group & aggregate, pivot, unpivot, join, formula columns, binning, date parts, one-hot / label encoding, scaling, sort, SQL query step · each step shows what it changed, with a live Python code view |
| **Recipe** | Every action is a step: drag to reorder, toggle, edit, undo/redo (Ctrl+Z / Ctrl+Y) |
| **Show me the code** | Export the recipe as a pandas `.py` script or Jupyter notebook, plus the cleaned data (CSV, Parquet, Excel) |
| **Verify in Python** | Runs the generated pandas code in the browser and checks it reproduces DuckDB's result (rows, columns, column totals) |
| **Visualise** | Drag columns onto X / Y / Colour / Size shelves · bar, line, area, scatter, histogram, box, heatmap, pie, treemap · smart chart suggestions · PNG/SVG export |
| **Analyse** | Wizard picks the test: Welch's t-test, ANOVA, chi-square, Pearson/Spearman, Shapiro-Wilk + Q-Q plot · effect sizes, assumption checks, plain-English results · correlation matrices incl. Cramér's V |
| **ML studio** | AutoML (5 models, k-fold CV leaderboard), ROC / confusion matrix / residuals, permutation importance, what-if sliders, batch prediction, scikit-learn code export · K-Means (elbow + silhouette) & DBSCAN with cluster profiles · PCA & t-SNE · Isolation Forest anomalies · time series resampling, decomposition, Holt-Winters forecast with 95% intervals |
| **Text to SQL** | Plain English → SQL (AI), or write SQL yourself with a clickable schema browser · runs locally, read-only · add the query to the recipe as a step (exported as `duckdb` code) |
| **Ask AI** | Plain-English questions → editable DuckDB SQL → table + chart · auto insights · "Explain this chart" |
| **Dashboard** | Charts + KPI cards on a drag-to-reorder, resizable grid · global category/date filters · click a bar to cross-filter · PNG / PDF export |
| **Extras** | Project autosave, EDA report (print to PDF), Ctrl+K command palette, guided first-analysis checklist, concept tooltips, light/dark mode |

## Performance

Measured in Chromium on a laptop (`PERF=1 npx playwright test e2e/perf.spec.ts`), with a 1,000,000-row × 7-column CSV (≈ 45 MB):

| | Time |
|---|---|
| Profile 1M rows (stats, histograms, outliers, duplicates, correlations) | **≈ 6 s** |
| Upload + parse + profile, end to end | ≈ 10–12 s |
| Jump to row 900,001 in the table | ≈ 0.2–0.3 s |

DuckDB-WASM currently runs single-threaded here. Serving the site with cross-origin isolation (COOP/COEP) would enable its multi-threaded build.

## AI safety & privacy

- The browser sends only table/column names, types, ranges, top category values and aggregates. Raw rows never leave the device (an end-to-end test asserts this).
- AI-written SQL must pass a guardrail: a single read-only `SELECT`, no file/URL/system functions, only the user's own tables. It runs locally with a row cap and one automatic retry on error.
- Visitors can bring their own Groq/Gemini key (stored only in their browser). The server key is rate-limited per visitor.

## Run locally

```bash
npm install
cp .env.example .env.local   # optional: add GROQ_API_KEY or GEMINI_API_KEY for the AI tab
npm run dev                  # http://localhost:3000
```

Everything except the AI tab works without any key.

## Tests

```bash
npm run lint
npm run typecheck
npm test                         # Vitest: formula compiler, SQL guardrail, codegen, quality score
npm run build && npm run test:e2e  # Playwright: every module end to end, incl. Python in the browser
```

The end-to-end suite builds 22-step and join/pivot recipes and verifies that the exported pandas code matches DuckDB exactly.

## Deploy (free)

1. Push to GitHub.
2. On vercel.com, **Add New Project**, import the repo, then **Deploy**.
3. Optional: add `GROQ_API_KEY` (free at console.groq.com) under Settings → Environment Variables, then redeploy.

## Project structure

```
app/                 landing (/), studio (/studio), AI route (/api/ai)
components/          studio shell, data table, profile, cleaning, chart builder, stats, ML, AI, dashboard, report
lib/duckdb/          DuckDB-WASM setup + query helpers
lib/data/            import, type detection, export
lib/profile/         profiling, quality score, warnings
lib/pipeline/        recipe steps (SQL + pandas), formula compiler, runner, code generator, verification
lib/python/          Pyodide worker + Python modules (stats, ML, time series)
lib/charts/          chart specs, recommendations, ECharts options
lib/ai/              AI client, SQL guardrail
lib/persist.ts       IndexedDB autosave
e2e/  tests/         Playwright and Vitest tests
```

## Data sources

`titanic.csv` and `iris.csv` come from the [seaborn-data](https://github.com/mwaskom/seaborn-data) repository. `sales.csv` and `chennai_weather.csv` are synthetic and generated for this demo.
