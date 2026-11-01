"use client";

import { create } from "zustand";
import {
  convertColumn,
  describeTable,
  detectFormat,
  fetchBytes,
  loadBytes,
  loadText,
  normalizeUrl,
  toTableName,
  type FileFormat,
} from "@/lib/data/load";
import { exec, ident } from "@/lib/duckdb/client";
import type { ColumnKind, Dataset } from "@/lib/data/types";

export type Tab = "data" | "profile";

interface StudioState {
  datasets: Dataset[];
  activeId: string | null;
  tab: Tab;
  busy: string | null;
  error: string | null;

  setTab: (tab: Tab) => void;
  setActive: (id: string) => void;
  clearError: () => void;
  addFile: (file: File) => Promise<void>;
  addUrl: (url: string, name?: string) => Promise<void>;
  addText: (text: string) => Promise<void>;
  removeDataset: (id: string) => Promise<void>;
  setColumnKind: (column: string, kind: ColumnKind) => Promise<void>;
}

export const useStudio = create<StudioState>((set, get) => {
  /** Shared wrapper: shows a busy message, catches errors, registers the dataset. */
  async function ingest(name: string, load: (table: string) => Promise<void>) {
    const table = toTableName(name, get().datasets.map((d) => d.table));
    set({ busy: `Loading ${name}…`, error: null });
    try {
      await load(table);
      const { rowCount, columns } = await describeTable(table);
      const ds: Dataset = { id: table, name, table, rowCount, columns, version: 0 };
      set((s) => ({ datasets: [...s.datasets, ds], activeId: ds.id, tab: "profile" }));
    } catch (e) {
      set({ error: `Couldn't load ${name}: ${(e as Error).message}` });
    } finally {
      set({ busy: null });
    }
  }

  return {
    datasets: [],
    activeId: null,
    tab: "profile",
    busy: null,
    error: null,

    setTab: (tab) => set({ tab }),
    setActive: (id) => set({ activeId: id }),
    clearError: () => set({ error: null }),

    addFile: async (file) => {
      const format = detectFormat(file.name);
      if (!format) {
        set({ error: `Unsupported file type: ${file.name}. Use CSV, TSV, JSON, Parquet or Excel.` });
        return;
      }
      await ingest(file.name, async (table) =>
        loadBytes(new Uint8Array(await file.arrayBuffer()), file.name, format, table),
      );
    },

    addUrl: async (rawUrl, name) => {
      const url = normalizeUrl(rawUrl.trim());
      const fileName = name ?? (url.split("/").pop()?.split("?")[0] || "remote.csv");
      const format: FileFormat = url.includes("docs.google.com") ? "csv" : (detectFormat(fileName) ?? "csv");
      await ingest(name ?? (url.includes("docs.google.com") ? "google_sheet.csv" : fileName), async (table) =>
        loadBytes(await fetchBytes(url), fileName, format, table),
      );
    },

    addText: async (text) => {
      await ingest("pasted_data", (table) => loadText(text, table));
    },

    removeDataset: async (id) => {
      const ds = get().datasets.find((d) => d.id === id);
      if (!ds) return;
      await exec(`DROP TABLE IF EXISTS ${ident(ds.table)}`);
      set((s) => {
        const datasets = s.datasets.filter((d) => d.id !== id);
        return { datasets, activeId: s.activeId === id ? (datasets[0]?.id ?? null) : s.activeId };
      });
    },

    setColumnKind: async (column, kind) => {
      const ds = get().datasets.find((d) => d.id === get().activeId);
      const col = ds?.columns.find((c) => c.name === column);
      if (!ds || !col || col.kind === kind) return;

      // category ↔ text on a VARCHAR column is only a label change; everything else casts.
      const labelOnly = col.duckType === "VARCHAR" && (kind === "category" || kind === "text");
      set({ busy: `Converting ${column} to ${kind}…` });
      try {
        let columns = ds.columns;
        if (!labelOnly) {
          await convertColumn(ds.table, column, kind);
          // Refresh physical types but keep earlier manual overrides on other columns.
          const previous = new Map(ds.columns.map((c) => [c.name, c.kind]));
          columns = (await describeTable(ds.table)).columns.map((c) => ({
            ...c,
            kind: previous.get(c.name) ?? c.kind,
          }));
        }
        columns = columns.map((c) => (c.name === column ? { ...c, kind } : c));
        set((s) => ({
          datasets: s.datasets.map((d) => (d.id === ds.id ? { ...d, columns, version: d.version + 1 } : d)),
        }));
      } catch (e) {
        set({ error: `Conversion failed: ${(e as Error).message}` });
      } finally {
        set({ busy: null });
      }
    },
  };
});

export const useActiveDataset = () =>
  useStudio((s) => s.datasets.find((d) => d.id === s.activeId) ?? null);
