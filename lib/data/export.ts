"use client";

import { exec, getDB, ident, lit, query } from "@/lib/duckdb/client";
import type { Dataset } from "./types";

export type ExportFormat = "csv" | "parquet" | "xlsx";

export function download(data: BlobPart, fileName: string, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Export the current (cleaned) table without it ever leaving the browser. */
export async function exportDataset(ds: Dataset, format: ExportFormat) {
  const base = `${ds.table}_clean`;
  if (format === "xlsx") {
    const XLSX = await import("xlsx");
    const rows = await query(`SELECT * FROM ${ident(ds.table)}`);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "data");
    const out = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
    download(out, `${base}.xlsx`, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    return;
  }
  const db = await getDB();
  const file = `${base}.${format}`;
  const opts = format === "csv" ? "(HEADER, DELIMITER ',')" : "(FORMAT PARQUET)";
  await exec(`COPY ${ident(ds.table)} TO ${lit(file)} ${opts}`);
  const buf = await db.copyFileToBuffer(file);
  await db.dropFile(file);
  download(buf as BlobPart, file, format === "csv" ? "text/csv" : "application/octet-stream");
}
