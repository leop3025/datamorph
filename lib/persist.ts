"use client";

import { exec, getDB, ident, lit } from "@/lib/duckdb/client";
import { describeTable } from "@/lib/data/load";
import type { Dataset } from "@/lib/data/types";
import { runRecipe } from "@/lib/pipeline/run";
import { useStudio, type DashFilter, type Widget } from "@/lib/store/studio";

/**
 * Project autosave in the browser's IndexedDB. Each dataset's untouched source table is stored
 * once as Parquet; the recipe, dashboard and filters are small JSON. Nothing leaves the device.
 */

const DB = "datamorph";
const VERSION = 1;

interface Session {
  datasets: Pick<Dataset, "id" | "name" | "table" | "sourceTable" | "source" | "steps" | "kindOverrides">[];
  activeId: string | null;
  widgets: Widget[];
  filters: DashFilter[];
  savedAt: number;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore("session");
      req.result.createObjectStore("tables");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
  });
}

const saved = new Set<string>();

async function saveSession() {
  const s = useStudio.getState();
  // Store each source table once (they never change after import).
  const db = await getDB();
  for (const d of s.datasets) {
    if (saved.has(d.sourceTable)) continue;
    const file = `persist_${d.sourceTable}.parquet`;
    await exec(`COPY ${ident(d.sourceTable)} TO ${lit(file)} (FORMAT PARQUET)`);
    const bytes = await db.copyFileToBuffer(file);
    await db.dropFile(file);
    await tx("tables", "readwrite", (st) => st.put(bytes, d.sourceTable));
    saved.add(d.sourceTable);
  }
  const keep = new Set(s.datasets.map((d) => d.sourceTable));
  const keys = (await tx<IDBValidKey[]>("tables", "readonly", (st) => st.getAllKeys())) ?? [];
  for (const k of keys) if (!keep.has(String(k))) await tx("tables", "readwrite", (st) => st.delete(k));

  const session: Session = {
    datasets: s.datasets.map(({ id, name, table, sourceTable, source, steps, kindOverrides }) => ({ id, name, table, sourceTable, source, steps, kindOverrides })),
    activeId: s.activeId,
    widgets: s.widgets,
    filters: s.filters,
    savedAt: Date.now(),
  };
  await tx("session", "readwrite", (st) => st.put(session, "current"));
}

let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;

/** Restore the last session (if any), then autosave on every relevant change. */
export async function startAutosave(): Promise<boolean> {
  if (started) return false;
  started = true;
  let restored = false;
  try {
    restored = await restore();
  } catch (e) {
    console.warn("Couldn't restore the previous session", e);
  }
  useStudio.subscribe((s, prev) => {
    if (s.datasets === prev.datasets && s.widgets === prev.widgets && s.filters === prev.filters && s.activeId === prev.activeId) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void saveSession().catch((e) => console.warn("Autosave failed", e)), 800);
  });
  return restored;
}

async function restore(): Promise<boolean> {
  const session = await tx<Session>("session", "readonly", (st) => st.get("current"));
  if (!session?.datasets.length) return false;
  useStudio.setState({ busy: "Restoring your last session…" });
  const db = await getDB();
  const shells: Dataset[] = [];
  for (const d of session.datasets) {
    const bytes = await tx<Uint8Array>("tables", "readonly", (st) => st.get(d.sourceTable));
    if (!bytes) continue;
    const file = `restore_${d.sourceTable}.parquet`;
    await db.registerFileBuffer(file, bytes);
    await exec(`CREATE OR REPLACE TABLE ${ident(d.sourceTable)} AS SELECT * FROM read_parquet(${lit(file)})`);
    await db.dropFile(file);
    await exec(`CREATE OR REPLACE TABLE ${ident(d.table)} AS SELECT * FROM ${ident(d.sourceTable)}`);
    const { rowCount, columns } = await describeTable(d.table);
    shells.push({ ...d, rowCount, columns, schemas: [columns], stepErrors: {}, version: 0 });
    saved.add(d.sourceTable);
  }
  // Replay recipes in order (joins may depend on earlier datasets).
  const ready: Dataset[] = [];
  for (const ds of shells) {
    const res = ds.steps.length ? await runRecipe(ds, ds.steps, shells) : null;
    ready.push(res ? { ...ds, ...res, version: 1 } : ds);
  }
  useStudio.setState({
    datasets: ready,
    activeId: ready.some((d) => d.id === session.activeId) ? session.activeId : (ready[0]?.id ?? null),
    widgets: session.widgets ?? [],
    filters: session.filters ?? [],
    busy: null,
  });
  return ready.length > 0;
}

/** Forget the saved project (used by "Start fresh"). */
export async function clearSession() {
  await tx("session", "readwrite", (st) => st.clear());
  await tx("tables", "readwrite", (st) => st.clear());
}
