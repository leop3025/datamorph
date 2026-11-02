"use client";

import { exec, getDB, ident, lit } from "@/lib/duckdb/client";
import type { Dataset } from "@/lib/data/types";
import { PY_SECTIONS, type PySection } from "./module";

/**
 * Python (Pyodide) in a Web Worker. Nothing is downloaded until the first call, and each
 * package (scipy, scikit-learn, statsmodels) is installed only when a feature needs it.
 */

export const PYODIDE_VERSION = "0.29.5";
const CDN = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

export type Package = "pandas" | "scipy" | "scikit-learn" | "statsmodels";

// The worker is plain JS: loading Pyodide from the CDN with importScripts keeps it out of the bundle.
const WORKER_SOURCE = `
importScripts("${CDN}pyodide.js");
let py = null;
const installed = new Set();
const sections = new Set();
const progress = (id, message) => postMessage({ id, progress: message });

async function ensure(id, packages) {
  if (!py) {
    progress(id, "Starting Python…");
    py = await loadPyodide({ indexURL: "${CDN}" });
  }
  const missing = packages.filter((p) => !installed.has(p));
  if (missing.length) {
    progress(id, "Installing " + missing.join(", ") + "…");
    await py.loadPackage(missing);
    missing.forEach((p) => installed.add(p));
  }
}

onmessage = async (e) => {
  const { id, packages, modules, files, fn, args, code } = e.data;
  try {
    await ensure(id, packages);
    for (const [name, source] of modules) {
      if (sections.has(name)) continue;
      py.runPython(source);
      sections.add(name);
    }
    for (const f of files || []) {
      py.FS.mkdirTree(f.path.split("/").slice(0, -1).join("/") || "/");
      py.FS.writeFile(f.path, f.data);
    }
    progress(id, "Running…");
    let out;
    if (code !== undefined) {
      out = await py.runPythonAsync(code);
    } else {
      out = py.globals.get("dispatch")(fn, JSON.stringify(args));
    }
    postMessage({ id, result: typeof out === "string" ? out : String(out) });
  } catch (err) {
    postMessage({ id, error: String(err && err.message ? err.message : err) });
  }
};
`;

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, { resolve: (v: string) => void; reject: (e: Error) => void; onProgress?: (m: string) => void }>();

function getWorker() {
  if (worker) return worker;
  const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
  worker = new Worker(url);
  worker.onmessage = (e) => {
    const { id, progress, result, error } = e.data;
    const p = pending.get(id);
    if (!p) return;
    if (progress) return p.onProgress?.(progress);
    pending.delete(id);
    if (error) p.reject(new Error(cleanPythonError(error)));
    else p.resolve(result);
  };
  return worker;
}

/** Keep the last line of a Python traceback (the actual error). */
function cleanPythonError(msg: string) {
  const lines = msg.trim().split("\n").filter(Boolean);
  return lines[lines.length - 1] ?? msg;
}

interface CallOptions {
  packages?: Package[];
  /** Module sections the call needs besides core (stats needs scipy, ml needs scikit-learn) */
  sections?: PySection[];
  files?: { path: string; data: Uint8Array }[];
  onProgress?: (message: string) => void;
}

function send(payload: Record<string, unknown>, opts: CallOptions): Promise<string> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress: opts.onProgress });
    const files = opts.files ?? [];
    getWorker().postMessage(
      {
        id,
        packages: ["pandas", ...(opts.packages ?? [])],
        modules: (["core", ...(opts.sections ?? [])] as PySection[]).map((s) => [s, PY_SECTIONS[s]]),
        files,
        ...payload,
      },
      files.map((f) => f.data.buffer as ArrayBuffer),
    );
  });
}

/** Call a function from the Datamorph Python module; arguments and result travel as JSON. */
export async function callPython<T>(fn: string, args: Record<string, unknown>, opts: CallOptions = {}): Promise<T> {
  return JSON.parse(await send({ fn, args }, opts)) as T;
}

/** Run arbitrary Python source; returns the value of the last expression as a string. */
export function runPython(code: string, opts: CallOptions = {}): Promise<string> {
  return send({ code }, opts);
}

/**
 * Export the chosen columns of a dataset as CSV for pandas. Only the needed columns travel,
 * and very large tables are sampled so the browser stays responsive.
 */
export async function frameFile(ds: Dataset, columns: string[], path: string, maxRows = 200_000, withRowId = false) {
  const db = await getDB();
  const cols = (withRowId ? "rowid AS __row, " : "") + (columns.length ? columns.map(ident).join(", ") : "*");
  const sample = ds.rowCount > maxRows ? ` USING SAMPLE ${maxRows} ROWS (reservoir, 42)` : "";
  const tmp = `py_${Math.random().toString(36).slice(2)}.csv`;
  await exec(`COPY (SELECT ${cols} FROM ${ident(ds.table)}${sample}) TO ${lit(tmp)} (HEADER, DELIMITER ',')`);
  const data = await db.copyFileToBuffer(tmp);
  await db.dropFile(tmp);
  const dates = ds.columns.filter((c) => c.kind === "date" && (!columns.length || columns.includes(c.name))).map((c) => c.name);
  return { file: { path, data }, dates, sampled: ds.rowCount > maxRows ? maxRows : null };
}
