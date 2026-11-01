"use client";

import * as duckdb from "@duckdb/duckdb-wasm";

// DuckDB runs in a Web Worker; the WASM bundle comes from jsDelivr so Next.js
// never has to bundle WebAssembly. Everything stays in the user's browser.

let dbPromise: Promise<duckdb.AsyncDuckDB> | null = null;

export function getDB(): Promise<duckdb.AsyncDuckDB> {
  if (!dbPromise) dbPromise = init();
  return dbPromise;
}

async function init() {
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
  const workerUrl = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" }),
  );
  const worker = new Worker(workerUrl);
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(workerUrl);
  return db;
}

export type Row = Record<string, unknown>;

/** Run SQL and return plain JS objects (BigInt → Number). */
export async function query<T extends Row = Row>(sql: string): Promise<T[]> {
  const db = await getDB();
  const conn = await db.connect();
  try {
    const result = await conn.query(sql);
    return result.toArray().map((r) => normalize(r.toJSON()) as T);
  } finally {
    await conn.close();
  }
}

function normalize(obj: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = typeof v === "bigint" ? Number(v) : v;
  }
  return out;
}

export async function exec(sql: string): Promise<void> {
  const db = await getDB();
  const conn = await db.connect();
  try {
    await conn.query(sql);
  } finally {
    await conn.close();
  }
}

/** Quote an identifier: my col → "my col" */
export const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** Quote a string literal. */
export const lit = (value: string) => `'${value.replace(/'/g, "''")}'`;
