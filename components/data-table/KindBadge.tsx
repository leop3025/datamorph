import { Calendar, CaseSensitive, Hash, Tags, ToggleLeft } from "lucide-react";
import type { ColumnKind } from "@/lib/data/types";

export const KIND_LABELS: Record<ColumnKind, string> = {
  number: "Number",
  date: "Date",
  category: "Category",
  text: "Text",
  boolean: "Boolean",
};

const ICONS = { number: Hash, date: Calendar, category: Tags, text: CaseSensitive, boolean: ToggleLeft };

const STYLES: Record<ColumnKind, string> = {
  number: "bg-info-soft text-info",
  date: "bg-good-soft text-good",
  category: "bg-accent-soft text-accent",
  text: "bg-surface-2 text-muted",
  boolean: "bg-warn-soft text-warn",
};

export function KindBadge({ kind }: { kind: ColumnKind }) {
  const Icon = ICONS[kind];
  return (
    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium ${STYLES[kind]}`}>
      <Icon className="h-3 w-3" />
      {KIND_LABELS[kind]}
    </span>
  );
}
