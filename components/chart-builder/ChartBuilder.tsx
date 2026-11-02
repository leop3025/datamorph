"use client";

import { useEffect, useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { Bot, Check, ImageDown, LayoutDashboard, Loader2, Search, Sparkles, X } from "lucide-react";
import { explainChart } from "@/lib/ai/client";
import type { ColumnInfo, Dataset } from "@/lib/data/types";
import {
  AGGS,
  CHART_TYPES,
  DEFAULT_SPEC,
  buildChart,
  incompatible,
  recommend,
  type ChartData,
  type ChartSpec,
  type Shelf,
} from "@/lib/charts/builder";
import { echarts } from "@/lib/charts/echarts";
import { EChart, useThemeColors } from "@/components/charts/EChart";
import { KindBadge } from "@/components/data-table/KindBadge";
import { download } from "@/lib/data/export";
import { useStudio } from "@/lib/store/studio";

const SHELVES: { id: Shelf; label: string; hint: string }[] = [
  { id: "x", label: "X axis", hint: "Category, date or number" },
  { id: "y", label: "Y axis", hint: "Number (empty = count rows)" },
  { id: "color", label: "Colour", hint: "Split into series" },
  { id: "size", label: "Size / value", hint: "Bubble size or heatmap value" },
];

export function ChartBuilder({ dataset }: { dataset: Dataset }) {
  const [spec, setSpec] = useState<ChartSpec>(() => initialSpec(dataset.columns));
  const [dragging, setDragging] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  // A chart type the user picked explicitly; otherwise the top suggestion is used.
  const [pinned, setPinned] = useState<ChartSpec["type"] | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const kind = (n?: string) => dataset.columns.find((c) => c.name === n)?.kind;
  const suggestions = recommend(kind(spec.x), kind(spec.y));

  /** Put a column on a shelf, then follow the best suggestion unless the user's own pick still fits. */
  const place = (shelf: Shelf, column: string | undefined) => {
    setSpec((s) => {
      const next: ChartSpec = { ...s, [shelf]: column };
      // A column can only sit on one shelf at a time.
      for (const other of SHELVES) if (other.id !== shelf && next[other.id] === column) next[other.id] = undefined;
      if (shelf === "x" || shelf === "y") {
        const rec = recommend(kind(next.x), kind(next.y));
        const keep = pinned && rec.includes(pinned) && !incompatible({ ...next, type: pinned }, dataset.columns);
        next.type = keep ? pinned : rec[0];
      }
      return next;
    });
  };

  const onDragStart = (e: DragStartEvent) => setDragging(String(e.active.id));
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setDragging(null);
    if (over) place(over.id as Shelf, String(active.id));
  };

  /** Click (or keyboard) alternative to dragging: fill the first empty shelf. */
  const quickAdd = (name: string) => {
    const shelf = (["x", "y", "color"] as Shelf[]).find((s) => !spec[s]);
    if (shelf) place(shelf, name);
  };

  const columns = dataset.columns.filter((c) => c.name.toLowerCase().includes(filter.toLowerCase()));

  return (
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
      <div className="grid h-full min-h-0 gap-4 lg:grid-cols-[15rem_minmax(0,1fr)]">
        <aside className="flex min-h-0 flex-col rounded-xl border bg-surface p-3">
          <h3 className="mb-1 font-semibold">Columns</h3>
          <p className="mb-2 text-xs text-muted">Drag onto a shelf, or click to add.</p>
          <label className="mb-2 flex items-center gap-2 rounded-lg border px-2 py-1">
            <Search className="h-3.5 w-3.5 text-muted" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Search"
              className="w-full bg-transparent text-sm outline-none"
              aria-label="Search columns"
            />
          </label>
          <ul className="min-h-0 flex-1 space-y-1 overflow-auto">
            {columns.map((c) => (
              <li key={c.name}>
                <ColumnChip column={c} onClick={() => quickAdd(c.name)} used={Object.values(spec).includes(c.name)} />
              </li>
            ))}
          </ul>
        </aside>

        <section className="flex min-h-0 min-w-0 flex-col gap-3">
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {SHELVES.map((s) => (
              <ShelfZone
                key={s.id}
                shelf={s}
                value={spec[s.id]}
                column={dataset.columns.find((c) => c.name === spec[s.id])}
                onClear={() => place(s.id, undefined)}
                extra={
                  (s.id === "y" && spec.y && !["scatter", "box", "histogram"].includes(spec.type)) ||
                  (s.id === "size" && spec.size && spec.type === "heatmap") ? (
                    <select
                      value={spec.agg}
                      onChange={(e) => setSpec({ ...spec, agg: e.target.value as ChartSpec["agg"] })}
                      className="rounded border bg-surface px-1 py-0.5 text-xs"
                      aria-label="Aggregation"
                    >
                      {AGGS.map((a) => (
                        <option key={a.value} value={a.value}>
                          {a.label}
                        </option>
                      ))}
                    </select>
                  ) : null
                }
              />
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {CHART_TYPES.map((t) => {
              const reason = incompatible({ ...spec, type: t.type }, dataset.columns);
              const suggested = suggestions[0] === t.type;
              return (
                <button
                  key={t.type}
                  onClick={() => {
                    setPinned(t.type);
                    setSpec({ ...spec, type: t.type });
                  }}
                  disabled={!!reason}
                  title={reason ?? t.hint}
                  className={`inline-flex items-center gap-1 rounded-full border px-3 py-1 text-sm disabled:opacity-35 ${
                    spec.type === t.type ? "border-accent bg-accent-soft text-accent" : "hover:bg-surface-2"
                  }`}
                >
                  {suggested && <Sparkles className="h-3 w-3" aria-label="Suggested" />}
                  {t.label}
                </button>
              );
            })}
            <Options spec={spec} setSpec={setSpec} dataset={dataset} />
          </div>

          <ChartCanvas dataset={dataset} spec={spec} />
        </section>
      </div>
      <DragOverlay dropAnimation={null}>
        {dragging && (
          <div className="rounded-lg border border-accent bg-surface px-2 py-1 text-sm shadow-lg">{dragging}</div>
        )}
      </DragOverlay>
    </DndContext>
  );
}

function initialSpec(cols: ColumnInfo[]): ChartSpec {
  const cat = cols.find((c) => c.kind === "category");
  const num = cols.find((c) => c.kind === "number");
  if (cat && num) return { ...DEFAULT_SPEC, x: cat.name, y: num.name, type: "bar" };
  return DEFAULT_SPEC;
}

function Options({ spec, setSpec, dataset }: { spec: ChartSpec; setSpec: (s: ChartSpec) => void; dataset: Dataset }) {
  const xIsDate = dataset.columns.find((c) => c.name === spec.x)?.kind === "date";
  return (
    <div className="ml-auto flex flex-wrap items-center gap-2 text-sm">
      {xIsDate && ["line", "area", "bar"].includes(spec.type) && (
        <label className="flex items-center gap-1 text-muted">
          Per
          <select
            value={spec.grain}
            onChange={(e) => setSpec({ ...spec, grain: e.target.value as ChartSpec["grain"] })}
            className="rounded border bg-surface px-1 py-0.5 text-text"
          >
            {["auto", "day", "week", "month", "quarter", "year"].map((g) => (
              <option key={g}>{g}</option>
            ))}
          </select>
        </label>
      )}
      {spec.color && ["bar", "area"].includes(spec.type) && (
        <label className="flex items-center gap-1 text-muted">
          <input type="checkbox" checked={spec.stack} onChange={(e) => setSpec({ ...spec, stack: e.target.checked })} /> Stack
        </label>
      )}
    </div>
  );
}

function ColumnChip({ column, onClick, used }: { column: ColumnInfo; onClick: () => void; used: boolean }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: column.name });
  return (
    <button
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      onClick={onClick}
      className={`flex w-full touch-none items-center justify-between gap-2 rounded-lg border px-2 py-1.5 text-left text-sm ${
        isDragging ? "opacity-40" : ""
      } ${used ? "border-accent/50 bg-accent-soft" : "hover:border-accent/60 hover:bg-surface-2"}`}
    >
      <span className="truncate">{column.name}</span>
      <KindBadge kind={column.kind} />
    </button>
  );
}

function ShelfZone({
  shelf,
  value,
  column,
  onClear,
  extra,
}: {
  shelf: (typeof SHELVES)[number];
  value?: string;
  column?: ColumnInfo;
  onClear: () => void;
  extra: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: shelf.id });
  return (
    <div
      ref={setNodeRef}
      className={`rounded-xl border-2 border-dashed px-3 py-2 transition-colors ${
        isOver ? "border-accent bg-accent-soft" : value ? "border-border bg-surface" : "border-border bg-surface/60"
      }`}
      data-shelf={shelf.id}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted">{shelf.label}</span>
        {extra}
      </div>
      {value && column ? (
        <div className="mt-1 flex items-center justify-between gap-2 text-sm font-medium">
          <span className="truncate">{value}</span>
          <button onClick={onClear} className="rounded p-0.5 text-muted hover:text-bad" aria-label={`Remove ${value} from ${shelf.label}`}>
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : (
        <p className="mt-1 text-sm text-muted">{shelf.hint}</p>
      )}
    </div>
  );
}

function ChartCanvas({ dataset, spec }: { dataset: Dataset; spec: ChartSpec }) {
  const theme = useThemeColors();
  const addWidget = useStudio((s) => s.addWidget);
  const [state, setState] = useState<{ key: string; data?: ChartData; error?: string } | null>(null);
  const [saved, setSaved] = useState(false);
  const [explanation, setExplanation] = useState<{ key: string; text?: string; loading?: boolean; error?: string } | null>(null);

  // Only the aggregated values that are plotted (at most 40 per series) are sent to the AI.
  const explain = async () => {
    if (!option) return;
    setExplanation({ key, loading: true });
    const o = option as { xAxis?: { data?: unknown[] }; series?: { name?: string; data?: unknown[] }[] };
    const summary = {
      chart: spec.type,
      x: o.xAxis?.data?.slice(0, 40),
      series: (o.series ?? []).map((s) => ({ name: s.name, values: (s.data ?? []).slice(0, 40) })),
    };
    try {
      setExplanation({ key, text: await explainChart(title, summary) });
    } catch (e) {
      setExplanation({ key, error: (e as Error).message });
    }
  };
  const chart = useRef<echarts.ECharts | null>(null);
  const problem = incompatible(spec, dataset.columns);
  const key = JSON.stringify([dataset.id, dataset.version, spec]);

  useEffect(() => {
    if (problem) return;
    let cancelled = false;
    buildChart(dataset, spec)
      .then((data) => !cancelled && setState({ key, data }))
      .catch((e: Error) => !cancelled && setState({ key, error: e.message.split("\n")[0] }));
    return () => {
      cancelled = true;
    };
  }, [dataset, spec, key, problem]);

  // React Compiler memoizes this, so the chart only re-renders when the data or theme change.
  const option = state?.data?.option(theme);
  const title = chartTitle(spec);

  const exportPng = () => {
    const url = chart.current?.getDataURL({ type: "png", pixelRatio: 2, backgroundColor: theme.surface });
    if (url) fetch(url).then((r) => r.blob()).then((b) => download(b, `${slug(title)}.png`, "image/png"));
  };
  const exportSvg = () => {
    if (!option) return;
    const el = chart.current?.getDom();
    const svg = echarts.init(null, null, { renderer: "svg", ssr: true, width: el?.clientWidth ?? 900, height: el?.clientHeight ?? 500 });
    svg.setOption({ ...option, animation: false, backgroundColor: theme.surface });
    download(svg.renderToSVGString(), `${slug(title)}.svg`, "image/svg+xml");
    svg.dispose();
  };

  return (
    <div className="flex min-h-[420px] flex-1 flex-col rounded-xl border bg-surface p-4">
      <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-semibold">{title}</h3>
          {state?.data?.note && state.key === key && <p className="text-xs text-muted">{state.data.note}</p>}
        </div>
        {!problem && option && (
          <div className="flex gap-1">
            <button onClick={explain} className="inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-xs hover:bg-surface-2">
              <Bot className="h-3.5 w-3.5" /> Explain
            </button>
            <button onClick={exportPng} className="inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-xs hover:bg-surface-2">
              <ImageDown className="h-3.5 w-3.5" /> PNG
            </button>
            <button onClick={exportSvg} className="inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-xs hover:bg-surface-2">
              <ImageDown className="h-3.5 w-3.5" /> SVG
            </button>
            <button
              onClick={() => {
                addWidget({ type: "chart", datasetId: dataset.id, title, spec });
                setSaved(true);
                setTimeout(() => setSaved(false), 1500);
              }}
              className="inline-flex items-center gap-1 rounded-lg bg-accent px-2 py-1 text-xs font-medium text-accent-fg"
            >
              {saved ? <Check className="h-3.5 w-3.5" /> : <LayoutDashboard className="h-3.5 w-3.5" />}
              {saved ? "Added" : "Add to dashboard"}
            </button>
          </div>
        )}
      </div>
      {explanation?.key === key && (
        <p className={`mb-2 rounded-lg px-3 py-2 text-sm ${explanation.error ? "bg-bad-soft text-bad" : "bg-accent-soft"}`} data-testid="chart-explanation">
          {explanation.loading ? "Explaining…" : (explanation.text ?? explanation.error)}
        </p>
      )}
      <div className="relative min-h-0 flex-1">
        {problem ? (
          <p className="flex h-full items-center justify-center text-sm text-muted">{problem}</p>
        ) : state?.error && state.key === key ? (
          <p className="flex h-full items-center justify-center text-sm text-bad">Couldn&apos;t draw this chart: {state.error}</p>
        ) : (
          <>
            {option && <EChart option={option} className="absolute inset-0" onInit={(c) => (chart.current = c)} />}
            {state?.key !== key && (
              <div className="absolute inset-0 flex items-center justify-center bg-surface/60">
                <Loader2 className="h-5 w-5 animate-spin text-muted" />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export function chartTitle(spec: ChartSpec) {
  const agg = AGGS.find((a) => a.value === spec.agg)!.label;
  const y = spec.y ? `${agg} of ${spec.y}` : "Rows";
  switch (spec.type) {
    case "scatter":
      return `${spec.y} vs ${spec.x}`;
    case "histogram":
      return `Distribution of ${spec.x ?? spec.y}`;
    case "box":
      return `${spec.y ?? spec.x}${spec.x && spec.y ? ` by ${spec.x}` : ""}`;
    case "heatmap":
      return `${spec.size ? `${agg} of ${spec.size}` : "Rows"} by ${spec.x} and ${spec.y}`;
    default:
      return `${y} by ${spec.x ?? "…"}${spec.color ? ` and ${spec.color}` : ""}`;
  }
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
