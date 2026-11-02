import type { ColumnProfile } from "@/lib/profile/profile";
import { KindBadge } from "@/components/data-table/KindBadge";
import { InfoTip } from "@/components/InfoTip";

const fmt = (v: number | string | undefined) => {
  if (v === undefined || v === null) return "–";
  if (typeof v === "string") return v.replace(/ 00:00:00$/, "");
  if (Number.isInteger(v)) return v.toLocaleString();
  return Math.abs(v) >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 1 }) : v.toPrecision(4).replace(/\.?0+$/, "");
};

export function ColumnCard({ profile: p, rowCount }: { profile: ColumnProfile; rowCount: number }) {
  const missingTone = p.missingPct >= 0.4 ? "text-bad" : p.missingPct >= 0.05 ? "text-warn" : "text-muted";
  return (
    <div className="flex flex-col rounded-xl border bg-surface p-4">
      <div className="mb-3 flex items-start justify-between gap-2">
        <h4 className="truncate font-medium" title={p.column.name}>
          {p.column.name}
        </h4>
        <KindBadge kind={p.column.kind} />
      </div>

      <dl className="mb-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
        <Item label="Missing" value={`${(p.missingPct * 100).toFixed(1)}%`} className={missingTone} />
        <Item label="Unique" value={p.unique.toLocaleString()} />
        {p.column.kind === "number" && (
          <>
            <Item label="Mean" value={fmt(p.mean)} />
            <Item label="Median" value={fmt(p.median)} />
            <Item label="Std dev" value={fmt(p.std)} />
            <Item label="Outliers" value={(p.outliers ?? 0).toLocaleString()} />
            <Item label="Min" value={fmt(p.min)} />
            <Item label="Max" value={fmt(p.max)} />
          </>
        )}
        {p.column.kind === "date" && (
          <>
            <Item label="From" value={fmt(p.min)} />
            <Item label="To" value={fmt(p.max)} />
          </>
        )}
      </dl>

      <div className="mt-auto">
        {p.histogram && <Histogram bins={p.histogram} />}
        {p.topValues &&
          (p.unique >= (rowCount - p.missing) * 0.95 && p.column.kind !== "date" ? (
            <p className="rounded bg-surface-2 px-2 py-1.5 text-xs text-muted">
              Nearly every value is unique, e.g. <span className="font-mono">{p.topValues[0]?.value}</span>
            </p>
          ) : (
            <TopValues values={p.topValues} total={rowCount - p.missing} />
          ))}
      </div>
    </div>
  );
}

function Item({ label, value, className = "" }: { label: string; value: string; className?: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="flex items-center gap-1 text-muted">
        {label}
        {label === "Outliers" && <InfoTip concept="iqr" />}
      </dt>
      <dd className={`truncate font-mono tabular-nums ${className}`}>{value}</dd>
    </div>
  );
}

function Histogram({ bins }: { bins: NonNullable<ColumnProfile["histogram"]> }) {
  const max = Math.max(...bins.map((b) => b.count), 1);
  return (
    <div>
      <div className="flex h-14 items-end gap-px" role="img" aria-label="Distribution">
        {bins.map((b, i) => (
          <div
            key={i}
            className="flex-1 rounded-t-sm bg-accent/70 hover:bg-accent"
            style={{ height: `${Math.max(b.count ? 4 : 0, (b.count / max) * 100)}%` }}
            title={`${fmt(b.from)} – ${fmt(b.to)}: ${b.count.toLocaleString()}`}
          />
        ))}
      </div>
      <div className="mt-1 flex justify-between font-mono text-[11px] text-muted">
        <span>{fmt(bins[0].from)}</span>
        <span>{fmt(bins[bins.length - 1].to)}</span>
      </div>
    </div>
  );
}

function TopValues({ values, total }: { values: { value: string; count: number }[]; total: number }) {
  return (
    <ul className="space-y-1">
      {values.map((v) => {
        const share = total ? v.count / total : 0;
        return (
          <li key={v.value} className="relative overflow-hidden rounded bg-surface-2 px-2 py-0.5 text-xs">
            <div className="absolute inset-y-0 left-0 bg-accent/15" style={{ width: `${share * 100}%` }} />
            <div className="relative flex justify-between gap-2">
              <span className="truncate" title={v.value}>
                {v.value === "" ? <em className="text-muted">(empty)</em> : v.value}
              </span>
              <span className="shrink-0 tabular-nums text-muted">{(share * 100).toFixed(1)}%</span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
