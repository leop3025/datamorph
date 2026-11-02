"use client";

import { useState } from "react";
import { Plus, Wand2, X } from "lucide-react";
import type { ColumnInfo, Dataset } from "@/lib/data/types";
import type { Field, Params, StepDef } from "@/lib/pipeline/types";
import { AGG_FUNCS, type Agg } from "@/lib/pipeline/steps/transform";
import { ident, query } from "@/lib/duckdb/client";

interface Props {
  def: StepDef;
  initial: Params;
  cols: ColumnInfo[];
  dataset: Dataset;
  datasets: Dataset[];
  submitLabel: string;
  onSubmit: (params: Params) => void;
  onCancel: () => void;
}

const input = "w-full rounded-lg border bg-surface px-2.5 py-1.5 text-sm outline-none focus:border-accent";

export function StepForm({ def, initial, cols, dataset, datasets, submitLabel, onSubmit, onCancel }: Props) {
  const [params, setParams] = useState<Params>(initial);
  const set = (key: string, value: unknown) => setParams((p) => ({ ...p, [key]: value }));
  const error = def.validate(params, cols);

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!error) onSubmit(params);
      }}
    >
      <div>
        <h3 className="font-semibold">{def.label}</h3>
        <p className="text-sm text-muted">{def.description}</p>
      </div>

      {def.fields
        .filter((f) => !f.showIf || f.showIf(params))
        .map((f) => (
          <div key={f.key} className="space-y-1">
            <label className="text-sm font-medium">
              {f.label}
              {f.optional && <span className="font-normal text-muted"> (optional)</span>}
            </label>
            <FieldInput field={f} params={params} set={set} cols={cols} dataset={dataset} datasets={datasets} />
            {f.help && <p className="text-xs text-muted">{f.help}</p>}
          </div>
        ))}

      {error && <p className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">{error}</p>}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={!!error}
          className="flex-1 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-fg disabled:opacity-40"
        >
          {submitLabel}
        </button>
        <button type="button" onClick={onCancel} className="rounded-lg border px-3 py-2 text-sm hover:bg-surface-2">
          Cancel
        </button>
      </div>
    </form>
  );
}

function FieldInput({
  field: f,
  params,
  set,
  cols,
  dataset,
  datasets,
}: {
  field: Field;
  params: Params;
  set: (k: string, v: unknown) => void;
  cols: ColumnInfo[];
  dataset: Dataset;
  datasets: Dataset[];
}) {
  const value = params[f.key];
  const allowed = f.kinds ? cols.filter((c) => f.kinds!.includes(c.kind)) : cols;

  switch (f.type) {
    case "column":
      return (
        <select className={input} value={value ?? ""} onChange={(e) => set(f.key, e.target.value)}>
          <option value="">Choose a column…</option>
          {allowed.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name} ({c.kind})
            </option>
          ))}
        </select>
      );

    case "columns": {
      const selected: string[] = value ?? [];
      const rest = allowed.filter((c) => !selected.includes(c.name));
      return (
        <div className="space-y-2">
          {selected.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {selected.map((name) => (
                <span key={name} className="inline-flex items-center gap-1 rounded bg-accent-soft px-2 py-0.5 text-xs text-accent">
                  {name}
                  <button type="button" onClick={() => set(f.key, selected.filter((n) => n !== name))} aria-label={`Remove ${name}`}>
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="flex gap-1">
            <select
              className={input}
              value=""
              onChange={(e) => e.target.value && set(f.key, [...selected, e.target.value])}
            >
              <option value="">Add a column…</option>
              {rest.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name} ({c.kind})
                </option>
              ))}
            </select>
            {rest.length > 0 && (
              <button
                type="button"
                className="shrink-0 rounded-lg border px-2 text-xs hover:bg-surface-2"
                onClick={() => set(f.key, [...selected, ...rest.map((c) => c.name)])}
              >
                All
              </button>
            )}
          </div>
        </div>
      );
    }

    case "select":
      return (
        <select className={input} value={value ?? ""} onChange={(e) => set(f.key, e.target.value)}>
          {f.options!.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );

    case "multiselect": {
      const selected: string[] = value ?? [];
      return (
        <div className="flex flex-wrap gap-1">
          {f.options!.map((o) => {
            const on = selected.includes(o.value);
            return (
              <button
                type="button"
                key={o.value}
                onClick={() => set(f.key, on ? selected.filter((v) => v !== o.value) : [...selected, o.value])}
                className={`rounded-full border px-2.5 py-1 text-xs ${on ? "border-accent bg-accent-soft text-accent" : "hover:bg-surface-2"}`}
                aria-pressed={on}
              >
                {o.label}
              </button>
            );
          })}
        </div>
      );
    }

    case "number":
      return (
        <input
          type="number"
          step="any"
          className={input}
          value={value ?? ""}
          onChange={(e) => set(f.key, e.target.value === "" ? "" : Number(e.target.value))}
        />
      );

    case "checkbox":
      return <input type="checkbox" checked={!!value} onChange={(e) => set(f.key, e.target.checked)} />;

    case "dataset": {
      const others = datasets.filter((d) => d.id !== dataset.id);
      return others.length ? (
        <select className={input} value={value ?? ""} onChange={(e) => set(f.key, e.target.value)}>
          <option value="">Choose a dataset…</option>
          {others.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      ) : (
        <p className="text-sm text-muted">Add a second dataset first (use + in the sidebar).</p>
      );
    }

    case "datasetColumn": {
      const other = datasets.find((d) => d.id === params[f.datasetKey!]);
      return (
        <select className={input} value={value ?? ""} disabled={!other} onChange={(e) => set(f.key, e.target.value)}>
          <option value="">{other ? "Choose a column…" : "Choose the dataset first"}</option>
          {other?.columns.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name} ({c.kind})
            </option>
          ))}
        </select>
      );
    }

    case "aggs":
      return <AggsInput aggs={value ?? []} onChange={(v) => set(f.key, v)} cols={cols} />;

    case "edges":
      return <EdgesInput value={value ?? ""} onChange={(v) => set(f.key, v)} column={params.column} dataset={dataset} />;

    case "sql":
      return (
        <textarea
          className={`${input} font-mono text-xs`}
          rows={8}
          spellCheck={false}
          value={value ?? ""}
          placeholder={f.placeholder}
          onChange={(e) => set(f.key, e.target.value)}
        />
      );

    default:
      return (
        <input
          className={input}
          value={value ?? ""}
          placeholder={f.placeholder}
          onChange={(e) => set(f.key, e.target.value)}
        />
      );
  }
}

function AggsInput({ aggs, onChange, cols }: { aggs: Agg[]; onChange: (a: Agg[]) => void; cols: ColumnInfo[] }) {
  const update = (i: number, change: Partial<Agg>) => onChange(aggs.map((a, j) => (j === i ? { ...a, ...change } : a)));
  return (
    <div className="space-y-2">
      {aggs.map((a, i) => (
        <div key={i} className="space-y-1 rounded-lg border p-2">
          <div className="flex gap-1">
            <select className={input} value={a.fn} onChange={(e) => update(i, { fn: e.target.value })}>
              {AGG_FUNCS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => onChange(aggs.filter((_, j) => j !== i))}
              className="shrink-0 rounded-lg px-2 text-muted hover:bg-surface-2 hover:text-bad"
              aria-label="Remove aggregation"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          {a.fn !== "rows" && (
            <select className={input} value={a.column} onChange={(e) => update(i, { column: e.target.value })}>
              <option value="">Column…</option>
              {cols.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name} ({c.kind})
                </option>
              ))}
            </select>
          )}
          <input className={input} placeholder="Output name (optional)" value={a.as} onChange={(e) => update(i, { as: e.target.value })} />
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...aggs, { column: "", fn: "mean", as: "" }])}
        className="inline-flex items-center gap-1 text-sm text-accent"
      >
        <Plus className="h-4 w-4" /> Add aggregation
      </button>
    </div>
  );
}

/** Edge list input with an "equal-width bins" helper that reads the column's range from DuckDB. */
function EdgesInput({
  value,
  onChange,
  column,
  dataset,
}: {
  value: string;
  onChange: (v: string) => void;
  column: string;
  dataset: Dataset;
}) {
  const [n, setN] = useState(4);
  const canAuto = !!column && dataset.columns.some((c) => c.name === column && c.kind === "number");
  const auto = async () => {
    const c = ident(column);
    const [{ lo, hi }] = await query<{ lo: number; hi: number }>(
      `SELECT min(${c})::DOUBLE AS lo, max(${c})::DOUBLE AS hi FROM ${ident(dataset.table)}`,
    );
    const step = (hi - lo) / n;
    const nice = (x: number) => Number(x.toPrecision(4));
    onChange(Array.from({ length: n + 1 }, (_, i) => nice(lo + i * step)).join(", "));
  };
  return (
    <div className="space-y-1">
      <input className={input} value={value} placeholder="0, 18, 35, 60, 100" onChange={(e) => onChange(e.target.value)} />
      {canAuto && (
        <div className="flex items-center gap-1 text-xs text-muted">
          <Wand2 className="h-3 w-3" /> Fill
          <input
            type="number"
            min={2}
            max={50}
            value={n}
            onChange={(e) => setN(Math.max(2, Math.min(50, Number(e.target.value) || 2)))}
            className="w-12 rounded border bg-surface px-1 py-0.5"
            aria-label="Number of bins"
          />
          <button type="button" onClick={auto} className="text-accent hover:underline">
            equal-width bins
          </button>
        </div>
      )}
    </div>
  );
}
