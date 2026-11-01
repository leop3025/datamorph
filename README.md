# Datamorph

**No-code data analysis that runs entirely in your browser.** Drop in a CSV, Excel, JSON or Parquet file and get an instant profile, data quality score and warnings. Cleaning, charts, statistics, AutoML and an AI assistant are on the roadmap.

> Live demo: _add your Vercel link here_

## Why browser-first?

All data processing happens on the visitor's machine with [DuckDB-WASM](https://duckdb.org/docs/api/wasm/overview). That means:

- **Privacy:** your data is never uploaded anywhere.
- **Speed:** a columnar SQL engine handles millions of rows.
- **Free hosting:** the server only serves static files, so there's no compute bill.

```
Browser
├── Next.js UI (React 19, Tailwind)
├── DuckDB-WASM (Web Worker)  → load, profile, query
└── ECharts                   → charts
Vercel
└── static hosting
```

## Features (so far)

- Import CSV/TSV, JSON/NDJSON, Parquet, Excel, a URL, a public Google Sheet, or pasted data
- Four built-in sample datasets (Titanic, Iris, retail sales, Chennai weather)
- Automatic type detection (number, date, category, text, boolean) with manual override
- Virtualised data table that loads rows on demand
- Auto profiling: missing %, unique counts, mean/median/std, histograms, top values
- Data quality score (0–100) with a breakdown, and plain-English warnings (missing data, duplicates, ID columns, skew, outliers, mixed types, inconsistent categories)
- Correlation heatmap

## Run locally

```bash
npm install
npm run dev          # http://localhost:3000
```

Checks:

```bash
npm run lint
npm run typecheck
npm run build && npm run test:e2e   # Playwright end-to-end tests
```

## Project structure

```
app/                  routes: landing (/) and studio (/studio)
components/           data-table, profile, upload, studio shell, charts
lib/duckdb/           DuckDB-WASM setup + query helpers
lib/data/             file loading, type detection, samples
lib/profile/          profiling, quality score, warnings, correlation
lib/store/            Zustand state
e2e/                  Playwright tests
public/samples/       sample datasets
```

## Roadmap

- [x] Upload, DuckDB-WASM, virtualised table, type detection
- [x] Auto profiling, quality score, correlation heatmap
- [ ] Cleaning studio with recipe steps, undo/redo, and pandas / notebook export
- [ ] Transformations and drag-and-drop chart builder
- [ ] Pyodide statistics (t-test, ANOVA, chi-square) with plain-English results
- [ ] AutoML, explainability, clustering, PCA, anomaly detection
- [ ] AI assistant (text-to-SQL, schema-only prompts) and dashboard builder
- [ ] Time series, reports, project autosave

## Data sources

`titanic.csv` and `iris.csv` come from the [seaborn-data](https://github.com/mwaskom/seaborn-data) repository. `sales.csv` and `chennai_weather.csv` are synthetic and generated for this demo.
