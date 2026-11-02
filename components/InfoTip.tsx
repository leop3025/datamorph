import { CircleHelp } from "lucide-react";

export const CONCEPTS = {
  quality:
    "A 0–100 summary of how analysis-ready the data is. Points are lost for missing cells, duplicate rows, outliers and columns that mix numbers with text.",
  iqr: "IQR rule: the interquartile range is Q3 − Q1 (the middle 50% of values). Values below Q1 − 1.5×IQR or above Q3 + 1.5×IQR are flagged as outliers.",
  cv: "Cross-validation splits the data into k parts, trains on k−1 and tests on the one left out, k times. The average score estimates how the model does on data it hasn't seen.",
  auc: "ROC AUC is the chance the model ranks a random positive case above a random negative one. 0.5 is guessing, 1.0 is perfect.",
  silhouette: "Silhouette measures how close each point is to its own cluster versus the next nearest one, from −1 to 1. Above 0.5 means clearly separated clusters.",
  importance: "Permutation importance: shuffle one column and see how much the score drops. A big drop means the model relies on that column.",
} as const;

/** A small "?" that explains a concept on hover or keyboard focus. */
export function InfoTip({ concept }: { concept: keyof typeof CONCEPTS }) {
  return (
    <span className="group relative inline-flex align-middle">
      <span tabIndex={0} className="cursor-help rounded-full text-muted outline-none hover:text-accent focus:text-accent" aria-label={CONCEPTS[concept]}>
        <CircleHelp className="h-3.5 w-3.5" />
      </span>
      <span
        role="tooltip"
        className="pointer-events-none absolute left-1/2 top-full z-30 mt-1 w-64 -translate-x-1/2 rounded-lg border bg-surface p-2 text-xs font-normal normal-case leading-relaxed text-text opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
      >
        {CONCEPTS[concept]}
      </span>
    </span>
  );
}
