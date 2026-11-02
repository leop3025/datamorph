"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, rectSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { FileDown, Filter, GripVertical, ImageDown, LayoutDashboard, Loader2, Maximize2, Minimize2, Plus, Trash2, X } from "lucide-react";
import type { Dataset } from "@/lib/data/types";
import { exec, ident, lit, query } from "@/lib/duckdb/client";
import { buildChart, fmt, type ChartData } from "@/lib/charts/builder";
import { download } from "@/lib/data/export";
import { useStudio, type DashFilter, type KpiAgg, type Widget } from "@/lib/store/studio";
import { EChart, useThemeColors } from "@/components/charts/EChart";

const KPI_AGGS: { value: KpiAgg; label: string; sql: (c: string) => string }[] = [
  { value: "count", label: "Row count", sql: () => "count(*)" },
  { value: "sum", label: "Sum", sql: (c) => `sum(${c})` },
  { value: "mean", label: "Average", sql: (c) => `avg(${c})` },
  { value: "median", label: "Median", sql: (c) => `median(${c})` },
  { value: "min", label: "Min", sql: (c) => `min(${c})` },
  { value: "max", label: "Max", sql: (c) => `max(${c})` },
  { value: "distinct", label: "Distinct count", sql: (c) => `count(DISTINCT ${c})` },
];

/**
 * Each dataset on the dashboard is read through a view that applies the global filters,
 * so every widget (chart or KPI) sees the same filtered data.
 */
async function filteredView(ds: Dataset, filters: DashFilter[]) {
  const view = `dash__${ds.table}`;
  const where = filters
    .filter((f) => ds.columns.some((c) => c.name === f.column))
    .map((f) => {
      const c = ident(f.column);
      if (f.values?.length) return `CAST(${c} AS VARCHAR) IN (${f.values.map(lit).join(", ")})`;
      const parts = [f.from && `${c} >= ${lit(f.from)}::TIMESTAMP`, f.to && `${c} < ${lit(f.to)}::TIMESTAMP + INTERVAL 1 DAY`].filter(Boolean);
      return parts.join(" AND ");
    })
    .filter(Boolean);
  await exec(`CREATE OR REPLACE VIEW ${ident(view)} AS SELECT * FROM ${ident(ds.table)}${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`);
  return { ...ds, table: view };
}

export function Dashboard() {
  const { widgets, datasets, filters, moveWidget, addWidget } = useStudio();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const gridRef = useRef<HTMLDivElement>(null);
  const [exporting, setExporting] = useState(false);
  const [adding, setAdding] = useState(false);

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    moveWidget(
      widgets.findIndex((w) => w.id === active.id),
      widgets.findIndex((w) => w.id === over.id),
    );
  };

  const exportPng = async () => {
    if (!gridRef.current) return;
    setExporting(true);
    try {
      const { toPng } = await import("html-to-image");
      const bg = getComputedStyle(document.body).backgroundColor;
      const url = await toPng(gridRef.current, { pixelRatio: 2, backgroundColor: bg, filter: (n) => !(n instanceof HTMLElement && n.dataset.noExport) });
      download(await (await fetch(url)).blob(), "dashboard.png", "image/png");
    } finally {
      setExporting(false);
    }
  };

  if (!widgets.length)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 rounded-xl border border-dashed bg-surface p-8 text-center">
        <LayoutDashboard className="h-10 w-10 text-accent" />
        <h2 className="text-lg font-semibold">Your dashboard is empty</h2>
        <p className="max-w-md text-sm text-muted">
          Build a chart in <b>Visualise</b> and click <b>Add to dashboard</b>, or add a KPI card here.
        </p>
        <button onClick={() => setAdding(true)} className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-fg">
          <Plus className="h-4 w-4" /> Add KPI card
        </button>
        {adding && <KpiForm datasets={datasets} onClose={() => setAdding(false)} onAdd={addWidget} />}
      </div>
    );

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 print:hidden">
        <FilterBar />
        <div className="ml-auto flex gap-2">
          <button onClick={() => setAdding((v) => !v)} className="inline-flex items-center gap-1.5 rounded-lg border bg-surface px-3 py-1.5 text-sm hover:bg-surface-2">
            <Plus className="h-4 w-4" /> KPI card
          </button>
          <button onClick={exportPng} disabled={exporting} className="inline-flex items-center gap-1.5 rounded-lg border bg-surface px-3 py-1.5 text-sm hover:bg-surface-2">
            {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImageDown className="h-4 w-4" />} PNG
          </button>
          <button onClick={() => window.print()} className="inline-flex items-center gap-1.5 rounded-lg border bg-surface px-3 py-1.5 text-sm hover:bg-surface-2">
            <FileDown className="h-4 w-4" /> PDF
          </button>
        </div>
      </div>
      {adding && <KpiForm datasets={datasets} onClose={() => setAdding(false)} onAdd={addWidget} />}

      <div className="min-h-0 flex-1 overflow-auto print:overflow-visible">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={widgets.map((w) => w.id)} strategy={rectSortingStrategy}>
            <div ref={gridRef} className="grid auto-rows-[150px] grid-cols-1 gap-3 p-0.5 sm:grid-cols-2 xl:grid-cols-4" data-testid="dashboard-grid">
              {widgets.map((w) => (
                <Tile key={w.id} widget={w} dataset={datasets.find((d) => d.id === w.datasetId)} filters={filters} />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      </div>
    </div>
  );
}

function Tile({ widget: w, dataset, filters }: { widget: Widget; dataset?: Dataset; filters: DashFilter[] }) {
  const { updateWidget, removeWidget } = useStudio();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: w.id });
  const span = { 1: "xl:col-span-1", 2: "sm:col-span-2 xl:col-span-2", 3: "sm:col-span-2 xl:col-span-3", 4: "sm:col-span-2 xl:col-span-4" }[w.w];
  const rows = w.type === "kpi" ? "row-span-1" : w.h === 2 ? "row-span-4" : "row-span-2";

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`group flex min-w-0 flex-col rounded-xl border bg-surface p-3 ${span} ${rows} ${isDragging ? "z-10 shadow-xl" : ""} break-inside-avoid`}
    >
      <div className="mb-1 flex items-start justify-between gap-2">
        <h3 className="truncate text-sm font-semibold" title={w.title}>{w.title}</h3>
        <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 print:hidden" data-no-export="true">
          <button {...attributes} {...listeners} className="cursor-grab touch-none rounded p-1 text-muted hover:bg-surface-2" aria-label="Move">
            <GripVertical className="h-3.5 w-3.5" />
          </button>
          {w.type === "chart" && (
            <>
              <button onClick={() => updateWidget(w.id, { w: w.w >= 4 ? 1 : w.w + 1 })} className="rounded px-1 text-xs text-muted hover:bg-surface-2" title="Width" aria-label="Change width">
                {w.w}/4
              </button>
              <button onClick={() => updateWidget(w.id, { h: w.h === 2 ? 1 : 2 })} className="rounded p-1 text-muted hover:bg-surface-2" aria-label={w.h === 2 ? "Shorter" : "Taller"}>
                {w.h === 2 ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
              </button>
            </>
          )}
          <button onClick={() => removeWidget(w.id)} className="rounded p-1 text-muted hover:bg-surface-2 hover:text-bad" aria-label="Remove">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      {!dataset ? (
        <p className="text-sm text-muted">The dataset for this widget was removed.</p>
      ) : w.type === "kpi" ? (
        <KpiValue widget={w} dataset={dataset} filters={filters} />
      ) : (
        <ChartTile widget={w} dataset={dataset} filters={filters} />
      )}
    </div>
  );
}

function useFiltered<T>(dataset: Dataset, filters: DashFilter[], run: (ds: Dataset) => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ key: string; value?: T; error?: string } | null>(null);
  const key = JSON.stringify([dataset.id, dataset.version, filters, ...deps]);
  useEffect(() => {
    let cancelled = false;
    filteredView(dataset, filters)
      .then(run)
      .then((value) => !cancelled && setState({ key, value }))
      .catch((e: Error) => !cancelled && setState({ key, error: e.message.split("\n")[0] }));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return { state, loading: state?.key !== key };
}

function ChartTile({ widget: w, dataset, filters }: { widget: Widget; dataset: Dataset; filters: DashFilter[] }) {
  const theme = useThemeColors();
  const toggle = useStudio((s) => s.toggleFilterValue);
  const { state, loading } = useFiltered<ChartData>(dataset, filters, (ds) => buildChart(ds, w.spec!), [w.spec]);
  const option = useMemo(() => state?.value?.option(theme), [state, theme]);
  const xKind = dataset.columns.find((c) => c.name === w.spec?.x)?.kind;
  const crossFilter = ["bar", "pie", "treemap"].includes(w.spec!.type) && (xKind === "category" || xKind === "boolean");

  return (
    <div className="relative min-h-0 flex-1">
      {state?.error ? (
        <p className="text-sm text-bad">{state.error}</p>
      ) : (
        option && (
          <EChart
            option={option}
            className="absolute inset-0"
            onClick={crossFilter ? (p) => toggle(w.spec!.x!, p.name) : undefined}
          />
        )
      )}
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-surface/50">
          <Loader2 className="h-4 w-4 animate-spin text-muted" />
        </div>
      )}
      {crossFilter && <span className="absolute bottom-0 right-0 text-[10px] text-muted print:hidden">Click a {w.spec!.type === "bar" ? "bar" : "slice"} to filter</span>}
    </div>
  );
}

function KpiValue({ widget: w, dataset, filters }: { widget: Widget; dataset: Dataset; filters: DashFilter[] }) {
  const agg = KPI_AGGS.find((a) => a.value === w.kpi!.agg)!;
  const { state } = useFiltered<number>(
    dataset,
    filters,
    async (ds) => {
      const [r] = await query<{ v: number }>(`SELECT ${agg.sql(w.kpi!.column ? ident(w.kpi!.column) : "*")}::DOUBLE AS v FROM ${ident(ds.table)}`);
      return r.v;
    },
    [w.kpi],
  );
  return (
    <div className="flex flex-1 flex-col justify-center">
      <div className="text-3xl font-semibold" data-testid="kpi-value">
        {state?.error ? <span className="text-sm text-bad">{state.error}</span> : state?.value === undefined ? "…" : fmt(state.value)}
      </div>
      <div className="text-xs text-muted">{dataset.name}</div>
    </div>
  );
}

function KpiForm({ datasets, onClose, onAdd }: { datasets: Dataset[]; onClose: () => void; onAdd: ReturnType<typeof useStudio.getState>["addWidget"] }) {
  const [datasetId, setDatasetId] = useState(datasets[0]?.id ?? "");
  const ds = datasets.find((d) => d.id === datasetId);
  const [agg, setAgg] = useState<KpiAgg>("sum");
  const [column, setColumn] = useState(ds?.columns.find((c) => c.kind === "number")?.name ?? "");
  const cols = ds?.columns.filter((c) => (agg === "distinct" ? true : c.kind === "number")) ?? [];
  const sel = "rounded-lg border bg-surface px-2 py-1.5 text-sm";
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-surface p-3 text-sm print:hidden">
      <span className="font-medium">New KPI:</span>
      <select className={sel} value={datasetId} onChange={(e) => setDatasetId(e.target.value)} aria-label="Dataset">
        {datasets.map((d) => (
          <option key={d.id} value={d.id}>{d.name}</option>
        ))}
      </select>
      <select className={sel} value={agg} onChange={(e) => setAgg(e.target.value as KpiAgg)} aria-label="Aggregation">
        {KPI_AGGS.map((a) => (
          <option key={a.value} value={a.value}>{a.label}</option>
        ))}
      </select>
      {agg !== "count" && (
        <select className={sel} value={column} onChange={(e) => setColumn(e.target.value)} aria-label="Column">
          <option value="">Column…</option>
          {cols.map((c) => (
            <option key={c.name}>{c.name}</option>
          ))}
        </select>
      )}
      <button
        disabled={!ds || (agg !== "count" && !column)}
        onClick={() => {
          const label = KPI_AGGS.find((a) => a.value === agg)!.label;
          onAdd({ type: "kpi", datasetId, title: agg === "count" ? "Rows" : `${label} of ${column}`, kpi: { agg, column: agg === "count" ? undefined : column } });
          onClose();
        }}
        className="rounded-lg bg-accent px-3 py-1.5 font-medium text-accent-fg disabled:opacity-40"
      >
        Add
      </button>
      <button onClick={onClose} className="rounded p-1 text-muted hover:bg-surface-2" aria-label="Cancel">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

/** Global filters: category values and date ranges, shared by all widgets. */
function FilterBar() {
  const { widgets, datasets, filters, setFilter } = useStudio();
  const [picking, setPicking] = useState(false);
  const used = datasets.filter((d) => widgets.some((w) => w.datasetId === d.id));
  const columns = [...new Map(used.flatMap((d) => d.columns.filter((c) => ["category", "boolean", "date"].includes(c.kind)).map((c) => [c.name, { ...c, ds: d }]))).values()];

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="filters">
      <Filter className="h-4 w-4 text-muted" />
      {filters.map((f) => (
        <FilterChip key={f.column} filter={f} column={columns.find((c) => c.name === f.column)} onRemove={() => setFilter(null, f.column)} onChange={setFilter} />
      ))}
      {picking ? (
        <select
          autoFocus
          className="rounded-lg border bg-surface px-2 py-1 text-sm"
          defaultValue=""
          onBlur={() => setPicking(false)}
          onChange={(e) => {
            const c = columns.find((x) => x.name === e.target.value);
            if (c) setFilter(c.kind === "date" ? { column: c.name, from: "", to: "" } : { column: c.name, values: [] });
            setPicking(false);
          }}
          aria-label="Filter column"
        >
          <option value="">Filter by…</option>
          {columns.filter((c) => !filters.some((f) => f.column === c.name)).map((c) => (
            <option key={c.name} value={c.name}>{c.name}</option>
          ))}
        </select>
      ) : (
        <button onClick={() => setPicking(true)} className="rounded-full border border-dashed px-3 py-1 text-sm text-muted hover:bg-surface-2">
          + Add filter
        </button>
      )}
    </div>
  );
}

function FilterChip({
  filter: f,
  column,
  onRemove,
  onChange,
}: {
  filter: DashFilter;
  column?: Dataset["columns"][number] & { ds: Dataset };
  onRemove: () => void;
  onChange: (f: DashFilter) => void;
}) {
  const [options, setOptions] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!column || column.kind === "date") return;
    query<{ v: string }>(`SELECT CAST(${ident(column.name)} AS VARCHAR) AS v FROM ${ident(column.ds.table)} WHERE ${ident(column.name)} IS NOT NULL GROUP BY 1 ORDER BY count(*) DESC LIMIT 50`).then((r) =>
      setOptions(r.map((x) => x.v)),
    );
  }, [column]);

  return (
    <span className="relative inline-flex items-center gap-1 rounded-full border border-accent bg-accent-soft px-3 py-1 text-sm text-accent">
      {column?.kind === "date" ? (
        <>
          {f.column}:
          <input type="date" value={f.from ?? ""} onChange={(e) => onChange({ ...f, from: e.target.value })} className="bg-transparent text-xs" aria-label={`${f.column} from`} />
          –
          <input type="date" value={f.to ?? ""} onChange={(e) => onChange({ ...f, to: e.target.value })} className="bg-transparent text-xs" aria-label={`${f.column} to`} />
        </>
      ) : (
        <button onClick={() => setOpen((v) => !v)}>
          {f.column}: {f.values?.length ? f.values.join(", ") : "all"}
        </button>
      )}
      <button onClick={onRemove} aria-label={`Remove ${f.column} filter`}>
        <X className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div onMouseLeave={() => setOpen(false)} className="absolute left-0 top-full z-20 mt-1 max-h-64 w-56 overflow-auto rounded-lg border bg-surface p-2 text-text shadow-lg">
          {options.map((o) => (
            <label key={o} className="flex items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-surface-2">
              <input
                type="checkbox"
                checked={f.values?.includes(o) ?? false}
                onChange={() => onChange({ ...f, values: f.values?.includes(o) ? f.values.filter((v) => v !== o) : [...(f.values ?? []), o] })}
              />
              {o}
            </label>
          ))}
        </div>
      )}
    </span>
  );
}
