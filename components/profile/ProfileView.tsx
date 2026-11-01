"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Info, Loader2, OctagonAlert, Timer } from "lucide-react";
import type { Dataset } from "@/lib/data/types";
import { profileDataset, type Profile, type Warning } from "@/lib/profile/profile";
import { ColumnCard } from "./ColumnCard";
import { CorrelationHeatmap } from "./CorrelationHeatmap";

export function ProfileView({ dataset }: { dataset: Dataset }) {
  const [result, setResult] = useState<{ key: string; profile?: Profile; error?: string } | null>(null);
  const key = `${dataset.id}:${dataset.version}`;

  useEffect(() => {
    let cancelled = false;
    profileDataset(dataset)
      .then((profile) => !cancelled && setResult({ key, profile }))
      .catch((e: Error) => !cancelled && setResult({ key, error: e.message }));
    return () => {
      cancelled = true;
    };
  }, [dataset, key]);

  if (!result || result.key !== key)
    return (
      <div className="flex h-64 items-center justify-center gap-2 text-muted">
        <Loader2 className="h-5 w-5 animate-spin" /> Profiling {dataset.rowCount.toLocaleString()} rows…
      </div>
    );
  if (result.error || !result.profile)
    return <div className="rounded-xl border border-bad/40 bg-bad-soft p-4 text-bad">Profiling failed: {result.error}</div>;

  const p = result.profile;
  return (
    <div className="space-y-6">
      <div className="grid gap-4 lg:grid-cols-3">
        <QualityCard profile={p} />
        <div className="rounded-xl border bg-surface p-5 lg:col-span-2">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="font-semibold">Warnings</h3>
            <span className="text-xs text-muted">{p.warnings.length} found</span>
          </div>
          {p.warnings.length === 0 ? (
            <p className="text-sm text-muted">No issues detected. This dataset looks clean.</p>
          ) : (
            <ul className="max-h-56 space-y-1.5 overflow-auto pr-1">
              {p.warnings.map((w, i) => (
                <WarningRow key={i} w={w} />
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Rows" value={p.rowCount.toLocaleString()} />
        <Stat label="Columns" value={p.columns.length.toString()} />
        <Stat label="Duplicate rows" value={p.duplicateRows.toLocaleString()} />
        <Stat
          label="Profiled in"
          value={p.elapsedMs < 1000 ? `${Math.round(p.elapsedMs)} ms` : `${(p.elapsedMs / 1000).toFixed(2)} s`}
          icon={<Timer className="h-3.5 w-3.5" />}
        />
      </div>

      <section>
        <h3 className="mb-3 font-semibold">Columns</h3>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {p.columns.map((c) => (
            <ColumnCard key={c.column.name} profile={c} rowCount={p.rowCount} />
          ))}
        </div>
      </section>

      {p.correlation && (
        <section className="rounded-xl border bg-surface p-5">
          <h3 className="font-semibold">Correlation heatmap</h3>
          <p className="mb-2 text-sm text-muted">
            Pearson correlation between numeric columns. Values near ±1 mean the columns move together.
          </p>
          <CorrelationHeatmap data={p.correlation} />
        </section>
      )}
    </div>
  );
}

function QualityCard({ profile }: { profile: Profile }) {
  const { score, breakdown } = profile.quality;
  const tone = score >= 90 ? "text-good" : score >= 70 ? "text-warn" : "text-bad";
  const label = score >= 90 ? "Good" : score >= 70 ? "Needs some cleaning" : "Needs cleaning";
  return (
    <div className="rounded-xl border bg-surface p-5">
      <h3 className="font-semibold">Data quality score</h3>
      <div className="mt-2 flex items-baseline gap-2">
        <span className={`text-5xl font-semibold tabular-nums ${tone}`}>{score}</span>
        <span className="text-muted">/ 100</span>
      </div>
      <p className={`text-sm ${tone}`}>{label}</p>
      <ul className="mt-4 space-y-1.5 text-sm">
        {breakdown.map((b) => (
          <li key={b.label} className="flex justify-between gap-2">
            <span className="text-muted">
              {b.label} <span className="text-xs">({b.detail})</span>
            </span>
            <span className="tabular-nums">{b.penalty > 0 ? `−${b.penalty.toFixed(1)}` : "0"}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function WarningRow({ w }: { w: Warning }) {
  const style = {
    critical: { cls: "bg-bad-soft text-bad", Icon: OctagonAlert },
    warn: { cls: "bg-warn-soft text-warn", Icon: AlertTriangle },
    info: { cls: "bg-info-soft text-info", Icon: Info },
  }[w.level];
  return (
    <li className={`flex items-start gap-2 rounded-lg px-3 py-2 text-sm ${style.cls}`}>
      <style.Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <span className="text-text">{w.message}</span>
    </li>
  );
}

function Stat({ label, value, icon }: { label: string; value: string; icon?: React.ReactNode }) {
  return (
    <div className="rounded-xl border bg-surface px-4 py-3">
      <div className="flex items-center gap-1 text-xs text-muted">
        {icon}
        {label}
      </div>
      <div className="mt-0.5 text-xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}
