"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ident, query } from "@/lib/duckdb/client";
import type { ColumnKind, Dataset } from "@/lib/data/types";
import { useStudio } from "@/lib/store/studio";
import { KindBadge, KIND_LABELS } from "./KindBadge";

const ROW_H = 32;
const COL_W = 168;
const INDEX_W = 64;
const BLOCK = 200;

type Cell = string | null;

/** DuckDB prints doubles in full (347545.4000000006); trim float noise for display, keep the raw value in the tooltip. */
function tidyNumber(v: string) {
  if (!/\.\d{7,}/.test(v)) return v;
  const n = Number(v);
  return Number.isFinite(n) ? String(Number(n.toPrecision(12))) : v;
}

/**
 * Virtualised table: only visible rows are rendered, and rows are fetched from
 * DuckDB in blocks of 200 as they scroll into view, so 1M rows scroll smoothly.
 */
export function DataTable({ dataset, highlight = [] }: { dataset: Dataset; highlight?: string[] }) {
  const setColumnKind = useStudio((s) => s.setColumnKind);
  const scrollRef = useRef<HTMLDivElement>(null);
  const blocks = useRef(new Map<number, Cell[][]>());
  const pending = useRef(new Set<number>());
  const [, force] = useState(0);

  const cols = dataset.columns;
  const width = INDEX_W + cols.length * COL_W;
  const marked = new Set(highlight);

  // Bring the first new column into view, since added columns land at the far right.
  const firstMarked = cols.findIndex((c) => marked.has(c.name));
  useEffect(() => {
    if (firstMarked >= 0) scrollRef.current?.scrollTo({ left: Math.max(0, firstMarked * COL_W - COL_W / 2) });
  }, [firstMarked]);

  const rows = useVirtualizer({
    count: dataset.rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 20,
  });

  const loadBlock = useCallback(
    async (b: number) => {
      if (blocks.current.has(b) || pending.current.has(b)) return;
      pending.current.add(b);
      try {
        const select = cols.map((c, i) => `CAST(${ident(c.name)} AS VARCHAR) AS c${i}`).join(", ");
        const data = await query(`SELECT ${select} FROM ${ident(dataset.table)} LIMIT ${BLOCK} OFFSET ${b * BLOCK}`);
        blocks.current.set(
          b,
          data.map((r) => cols.map((_, i) => (r[`c${i}`] ?? null) as Cell)),
        );
        force((x) => x + 1);
      } finally {
        pending.current.delete(b);
      }
    },
    [cols, dataset.table],
  );

  const items = rows.getVirtualItems();
  const first = items[0]?.index ?? 0;
  const last = items[items.length - 1]?.index ?? 0;

  useEffect(() => {
    for (let b = Math.floor(first / BLOCK); b <= Math.floor(last / BLOCK); b++) loadBlock(b);
  }, [first, last, loadBlock]);

  return (
    <div ref={scrollRef} className="h-full overflow-auto rounded-xl border bg-surface">
      <div style={{ width, minWidth: "100%" }}>
        {/* Header */}
        <div className="sticky top-0 z-10 flex border-b bg-surface-2 text-xs" style={{ height: 52 }}>
          <div className="sticky left-0 z-10 flex items-end border-r bg-surface-2 px-2 pb-2 text-muted" style={{ width: INDEX_W }}>
            #
          </div>
          {cols.map((c) => (
            <div
              key={c.name}
              className={`flex flex-col justify-center gap-1 border-r px-2 ${marked.has(c.name) ? "bg-accent-soft" : ""}`}
              style={{ width: COL_W }}
            >
              <span className="truncate font-medium text-text" title={`${c.name} (${c.duckType})`}>
                {c.name}
              </span>
              <label className="relative inline-flex w-fit cursor-pointer items-center" title="Change column type">
                <KindBadge kind={c.kind} />
                <select
                  value={c.kind}
                  onChange={(e) => setColumnKind(c.name, e.target.value as ColumnKind)}
                  className="absolute inset-0 cursor-pointer opacity-0"
                  aria-label={`Type of ${c.name}`}
                >
                  {(Object.keys(KIND_LABELS) as ColumnKind[]).map((k) => (
                    <option key={k} value={k}>
                      {KIND_LABELS[k]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ))}
        </div>

        {/* Body */}
        <div style={{ height: rows.getTotalSize(), position: "relative" }}>
          {items.map((v) => {
            const row = blocks.current.get(Math.floor(v.index / BLOCK))?.[v.index % BLOCK];
            return (
              <div
                key={v.key}
                className="absolute left-0 flex border-b text-sm hover:bg-surface-2"
                style={{ top: v.start, height: ROW_H, width }}
              >
                <div
                  className="sticky left-0 flex items-center border-r bg-surface px-2 font-mono text-xs text-muted"
                  style={{ width: INDEX_W }}
                >
                  {v.index + 1}
                </div>
                {cols.map((c, i) => {
                  const value = row?.[i];
                  return (
                    <div
                      key={c.name}
                      className={`flex items-center truncate border-r px-2 ${c.kind === "number" ? "justify-end font-mono tabular-nums" : ""} ${marked.has(c.name) ? "bg-accent-soft/40" : ""}`}
                      style={{ width: COL_W }}
                      title={value ?? undefined}
                    >
                      {row === undefined ? (
                        <span className="h-3 w-16 animate-pulse rounded bg-surface-2" />
                      ) : value === null ? (
                        <span className="text-xs italic text-muted/60">null</span>
                      ) : (
                        <span className="truncate">{c.kind === "number" ? tidyNumber(value ?? "") : value}</span>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
