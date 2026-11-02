"use client";

import { create } from "zustand";
import {
  describeTable,
  detectFormat,
  fetchBytes,
  loadBytes,
  loadText,
  normalizeUrl,
  toTableName,
} from "@/lib/data/load";
import { exec, ident } from "@/lib/duckdb/client";
import type { ColumnKind, Dataset, DataSource, FileFormat } from "@/lib/data/types";
import { runRecipe } from "@/lib/pipeline/run";
import type { Params, Step } from "@/lib/pipeline/types";
import type { ChartSpec } from "@/lib/charts/builder";

export type Tab = "profile" | "data" | "clean" | "transform" | "visualize" | "analyze" | "ml" | "ai" | "sql" | "dashboard";

export type KpiAgg = "count" | "sum" | "mean" | "median" | "min" | "max" | "distinct";

/** A dashboard tile: a saved chart or a KPI card. w = columns (1–4), h = rows (1–2). */
export interface Widget {
  id: string;
  type: "chart" | "kpi";
  datasetId: string;
  title: string;
  spec?: ChartSpec;
  kpi?: { column?: string; agg: KpiAgg };
  w: number;
  h: number;
}

/** Dashboard-wide filters, applied to every widget whose dataset has the column. */
export interface DashFilter {
  column: string;
  values?: string[];
  from?: string;
  to?: string;
}

interface History {
  past: Step[][];
  future: Step[][];
}

interface StudioState {
  datasets: Dataset[];
  activeId: string | null;
  tab: Tab;
  busy: string | null;
  error: string | null;
  history: Record<string, History>;
  widgets: Widget[];
  /** Tabs the user has opened (drives the getting-started checklist) */
  visited: Partial<Record<Tab, boolean>>;
  /** A tool the command palette asked the Clean/Transform workspace to open */
  pendingTool: string | null;
  reportOpen: boolean;
  openTool: (type: string, group: "clean" | "transform") => void;
  clearPendingTool: () => void;
  setReportOpen: (open: boolean) => void;
  filters: DashFilter[];

  addWidget: (w: Omit<Widget, "id" | "w" | "h"> & Partial<Pick<Widget, "w" | "h">>) => string;
  updateWidget: (id: string, change: Partial<Widget>) => void;
  removeWidget: (id: string) => void;
  moveWidget: (from: number, to: number) => void;
  setFilter: (f: DashFilter | null, column?: string) => void;
  /** Toggle one value of a category filter (used by click-to-cross-filter) */
  toggleFilterValue: (column: string, value: string) => void;
  setTab: (tab: Tab) => void;
  setActive: (id: string) => void;
  clearError: () => void;
  addFile: (file: File) => Promise<void>;
  addUrl: (url: string, name?: string, sample?: boolean) => Promise<void>;
  addText: (text: string) => Promise<void>;
  removeDataset: (id: string) => Promise<void>;
  setColumnKind: (column: string, kind: ColumnKind) => Promise<void>;

  // Recipe editing (all apply to the active dataset)
  addStep: (type: string, params: Params) => Promise<void>;
  updateStep: (id: string, params: Params) => Promise<void>;
  removeStep: (id: string) => Promise<void>;
  toggleStep: (id: string) => Promise<void>;
  moveStep: (from: number, to: number) => Promise<void>;
  clearSteps: () => Promise<void>;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
}

// crypto.randomUUID only exists in secure contexts (https/localhost); getRandomValues works over plain http on a LAN IP too.
const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, "0")).join("");

export const useStudio = create<StudioState>((set, get) => {
  const active = () => get().datasets.find((d) => d.id === get().activeId) ?? null;

  const patch = (id: string, change: Partial<Dataset>) =>
    set((s) => ({ datasets: s.datasets.map((d) => (d.id === id ? { ...d, ...change } : d)) }));

  // Recipe runs are serialised: if the recipe changes mid-run, it runs again with the latest steps.
  const running = new Set<string>();
  const rerun = new Set<string>();

  async function rebuild(id: string) {
    if (running.has(id)) {
      rerun.add(id);
      return;
    }
    running.add(id);
    set({ busy: "Applying recipe…" });
    try {
      do {
        rerun.delete(id);
        const ds = get().datasets.find((d) => d.id === id);
        if (!ds) break;
        const result = await runRecipe(ds, ds.steps, get().datasets);
        patch(id, { ...result, version: (get().datasets.find((d) => d.id === id)?.version ?? 0) + 1 });
      } while (rerun.has(id));
      // Datasets that join this one now see different data.
      for (const d of get().datasets)
        if (d.id !== id && d.steps.some((s) => s.enabled && s.type === "join" && s.params.right === id)) void rebuild(d.id);
    } catch (e) {
      set({ error: `Recipe failed: ${(e as Error).message}` });
    } finally {
      running.delete(id);
      if (running.size === 0) set({ busy: null });
    }
  }

  /** Replace the active dataset's steps, recording undo history, then rebuild. */
  async function commit(steps: Step[]) {
    const ds = active();
    if (!ds) return;
    const h = get().history[ds.id] ?? { past: [], future: [] };
    set((s) => ({
      history: { ...s.history, [ds.id]: { past: [...h.past, ds.steps].slice(-100), future: [] } },
    }));
    patch(ds.id, { steps });
    await rebuild(ds.id);
  }

  async function ingest(name: string, source: Omit<DataSource, "dateColumns">, load: (table: string) => Promise<void>) {
    const table = toTableName(name, get().datasets.map((d) => d.table));
    const sourceTable = `${table}__source`;
    set({ busy: `Loading ${name}…`, error: null });
    try {
      await load(sourceTable);
      await exec(`CREATE OR REPLACE TABLE ${ident(table)} AS SELECT * FROM ${ident(sourceTable)}`);
      const { rowCount, columns } = await describeTable(table);
      const ds: Dataset = {
        id: table,
        name,
        table,
        sourceTable,
        source: { ...source, dateColumns: columns.filter((c) => c.kind === "date").map((c) => c.name) },
        rowCount,
        columns,
        steps: [],
        schemas: [columns],
        stepErrors: {},
        kindOverrides: {},
        version: 0,
      };
      set((s) => ({ datasets: [...s.datasets, ds], activeId: ds.id, tab: "profile" }));
    } catch (e) {
      set({ error: `Couldn't load ${name}: ${(e as Error).message}` });
    } finally {
      set({ busy: null });
    }
  }

  const withActive = (fn: (ds: Dataset) => Step[] | null) => async () => {
    const ds = active();
    if (!ds) return;
    const steps = fn(ds);
    if (steps) await commit(steps);
  };

  return {
    datasets: [],
    activeId: null,
    tab: "profile",
    busy: null,
    error: null,
    history: {},
    widgets: [],
    visited: {},
    pendingTool: null,
    reportOpen: false,
    openTool: (type, group) => set((s) => ({ tab: group, pendingTool: type, visited: { ...s.visited, [group]: true } })),
    clearPendingTool: () => set({ pendingTool: null }),
    setReportOpen: (reportOpen) => set({ reportOpen }),
    filters: [],

    addWidget: (w) => {
      const id = newId();
      set((s) => ({ widgets: [...s.widgets, { w: w.type === "kpi" ? 1 : 2, h: 1, ...w, id }] }));
      return id;
    },
    updateWidget: (id, change) => set((s) => ({ widgets: s.widgets.map((w) => (w.id === id ? { ...w, ...change } : w)) })),
    removeWidget: (id) => set((s) => ({ widgets: s.widgets.filter((w) => w.id !== id) })),
    moveWidget: (from, to) =>
      set((s) => {
        const widgets = [...s.widgets];
        const [w] = widgets.splice(from, 1);
        widgets.splice(to, 0, w);
        return { widgets };
      }),
    setFilter: (f, column) =>
      set((s) => {
        const col = f?.column ?? column;
        const rest = s.filters.filter((x) => x.column !== col);
        return { filters: f ? [...rest, f] : rest };
      }),
    toggleFilterValue: (column, value) =>
      set((s) => {
        const cur = s.filters.find((f) => f.column === column);
        const values = cur?.values?.includes(value) ? cur.values.filter((v) => v !== value) : [...(cur?.values ?? []), value];
        const rest = s.filters.filter((f) => f.column !== column);
        return { filters: values.length ? [...rest, { column, values }] : rest };
      }),

    setTab: (tab) => set((s) => ({ tab, visited: { ...s.visited, [tab]: true } })),
    setActive: (id) => set({ activeId: id }),
    clearError: () => set({ error: null }),

    addFile: async (file) => {
      const format = detectFormat(file.name);
      if (!format) {
        set({ error: `Unsupported file type: ${file.name}. Use CSV, TSV, JSON, Parquet or Excel.` });
        return;
      }
      await ingest(file.name, { fileName: file.name, format }, async (table) =>
        loadBytes(new Uint8Array(await file.arrayBuffer()), file.name, format, table),
      );
    },

    addUrl: async (rawUrl, name, sample = false) => {
      const url = normalizeUrl(rawUrl.trim());
      const isSheet = url.includes("docs.google.com");
      const fileName = name ?? (isSheet ? "google_sheet.csv" : url.split("/").pop()?.split("?")[0] || "remote.csv");
      const format: FileFormat = isSheet ? "csv" : (detectFormat(fileName) ?? "csv");
      await ingest(fileName, { fileName, format, url, sample }, async (table) =>
        loadBytes(await fetchBytes(url), fileName, format, table),
      );
    },

    addText: async (text) => {
      await ingest("pasted_data.csv", { fileName: "pasted_data.csv", format: "csv" }, (table) => loadText(text, table));
    },

    removeDataset: async (id) => {
      const ds = get().datasets.find((d) => d.id === id);
      if (!ds) return;
      await exec(`DROP TABLE IF EXISTS ${ident(ds.table)}`);
      await exec(`DROP TABLE IF EXISTS ${ident(ds.sourceTable)}`);
      set((s) => {
        const datasets = s.datasets.filter((d) => d.id !== id);
        return { datasets, activeId: s.activeId === id ? (datasets[0]?.id ?? null) : s.activeId };
      });
      // Datasets joining the removed one will now report that step as failed.
      for (const d of get().datasets)
        if (d.steps.some((s) => s.type === "join" && s.params.right === id)) void rebuild(d.id);
    },

    setColumnKind: async (column, kind) => {
      const ds = active();
      const col = ds?.columns.find((c) => c.name === column);
      if (!ds || !col || col.kind === kind) return;
      // category ↔ text on a text column is only a label; anything else is a real conversion step.
      if (col.duckType === "VARCHAR" && (kind === "category" || kind === "text")) {
        const kindOverrides = { ...ds.kindOverrides, [column]: kind };
        patch(ds.id, {
          kindOverrides,
          columns: ds.columns.map((c) => (c.name === column ? { ...c, kind } : c)),
          version: ds.version + 1,
        });
        return;
      }
      const to = kind === "category" ? "text" : kind;
      await commit([...ds.steps, { id: newId(), type: "changeType", enabled: true, params: { column, to, format: "" } }]);
    },

    addStep: async (type, params) =>
      withActive((ds) => [...ds.steps, { id: newId(), type, enabled: true, params }])(),
    updateStep: async (id, params) =>
      withActive((ds) => ds.steps.map((s) => (s.id === id ? { ...s, params } : s)))(),
    removeStep: async (id) => withActive((ds) => ds.steps.filter((s) => s.id !== id))(),
    toggleStep: async (id) =>
      withActive((ds) => ds.steps.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s)))(),
    moveStep: async (from, to) =>
      withActive((ds) => {
        if (from === to) return null;
        const steps = [...ds.steps];
        const [s] = steps.splice(from, 1);
        steps.splice(to, 0, s);
        return steps;
      })(),
    clearSteps: async () => withActive((ds) => (ds.steps.length ? [] : null))(),

    undo: async () => {
      const ds = active();
      const h = ds && get().history[ds.id];
      if (!ds || !h?.past.length) return;
      const prev = h.past[h.past.length - 1];
      set((s) => ({
        history: { ...s.history, [ds.id]: { past: h.past.slice(0, -1), future: [ds.steps, ...h.future] } },
      }));
      patch(ds.id, { steps: prev });
      await rebuild(ds.id);
    },

    redo: async () => {
      const ds = active();
      const h = ds && get().history[ds.id];
      if (!ds || !h?.future.length) return;
      const [nextSteps, ...rest] = h.future;
      set((s) => ({ history: { ...s.history, [ds.id]: { past: [...h.past, ds.steps], future: rest } } }));
      patch(ds.id, { steps: nextSteps });
      await rebuild(ds.id);
    },
  };
});

export const useActiveDataset = () =>
  useStudio((s) => s.datasets.find((d) => d.id === s.activeId) ?? null);
