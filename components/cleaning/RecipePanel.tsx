"use client";

import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { AlertCircle, Code2, Eye, EyeOff, GripVertical, Pencil, Redo2, Trash2, Undo2 } from "lucide-react";
import type { Dataset } from "@/lib/data/types";
import { getStepDef } from "@/lib/pipeline/registry";
import type { Step } from "@/lib/pipeline/types";
import { useStudio } from "@/lib/store/studio";

export function RecipePanel({
  dataset,
  editingId,
  onEdit,
  onShowCode,
}: {
  dataset: Dataset;
  editingId: string | null;
  onEdit: (step: Step) => void;
  onShowCode: () => void;
}) {
  const { datasets, history, moveStep, undo, redo, clearSteps } = useStudio();
  const h = history[dataset.id];
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = dataset.steps.findIndex((s) => s.id === active.id);
    const to = dataset.steps.findIndex((s) => s.id === over.id);
    void moveStep(from, to);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="font-semibold">Recipe</h3>
          <p className="text-xs text-muted">
            {dataset.steps.length} step{dataset.steps.length === 1 ? "" : "s"} · drag to reorder
          </p>
        </div>
        <div className="flex gap-1">
          <IconButton label="Undo (Ctrl+Z)" disabled={!h?.past.length} onClick={undo}>
            <Undo2 className="h-4 w-4" />
          </IconButton>
          <IconButton label="Redo (Ctrl+Y)" disabled={!h?.future.length} onClick={redo}>
            <Redo2 className="h-4 w-4" />
          </IconButton>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {dataset.steps.length === 0 ? (
          <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted">
            No steps yet. Pick a tool to start. Every action you take is recorded here and can be exported as Python.
          </p>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={dataset.steps.map((s) => s.id)} strategy={verticalListSortingStrategy}>
              <ol className="space-y-1.5">
                {dataset.steps.map((s, i) => (
                  <StepItem
                    key={s.id}
                    step={s}
                    index={i}
                    summary={getStepDef(s.type).summary(s.params, datasets)}
                    error={dataset.stepErrors[s.id]}
                    editing={editingId === s.id}
                    onEdit={() => onEdit(s)}
                  />
                ))}
              </ol>
            </SortableContext>
          </DndContext>
        )}
      </div>

      <div className="mt-3 space-y-2 border-t pt-3">
        <button
          onClick={onShowCode}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-fg"
        >
          <Code2 className="h-4 w-4" /> Show me the code
        </button>
        {dataset.steps.length > 0 && (
          <button onClick={clearSteps} className="w-full text-xs text-muted hover:text-bad">
            Clear all steps
          </button>
        )}
      </div>
    </div>
  );
}

function StepItem({
  step,
  index,
  summary,
  error,
  editing,
  onEdit,
}: {
  step: Step;
  index: number;
  summary: string;
  error?: string;
  editing: boolean;
  onEdit: () => void;
}) {
  const { toggleStep, removeStep } = useStudio();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: step.id });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`group rounded-lg border bg-surface text-sm ${isDragging ? "z-10 shadow-lg" : ""} ${
        editing ? "border-accent" : error ? "border-bad/50" : ""
      } ${step.enabled ? "" : "opacity-50"}`}
    >
      <div className="flex items-start gap-1 p-2">
        <button
          {...attributes}
          {...listeners}
          className="mt-0.5 cursor-grab touch-none text-muted active:cursor-grabbing"
          aria-label={`Reorder step ${index + 1}`}
        >
          <GripVertical className="h-4 w-4" />
        </button>
        <span className="mt-0.5 w-5 shrink-0 text-xs tabular-nums text-muted">{index + 1}.</span>
        <span className={`min-w-0 flex-1 break-words ${step.enabled ? "" : "line-through"}`}>{summary}</span>
        <div className="flex shrink-0 gap-0.5 opacity-60 group-hover:opacity-100">
          <IconButton label={step.enabled ? "Disable step" : "Enable step"} onClick={() => toggleStep(step.id)}>
            {step.enabled ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
          </IconButton>
          <IconButton label="Edit step" onClick={onEdit}>
            <Pencil className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton label="Delete step" onClick={() => removeStep(step.id)} danger>
            <Trash2 className="h-3.5 w-3.5" />
          </IconButton>
        </div>
      </div>
      {error && (
        <p className="flex items-start gap-1.5 border-t border-bad/30 bg-bad-soft px-2 py-1.5 text-xs text-bad">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> Skipped: {error}
        </p>
      )}
    </li>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={`rounded p-1 text-muted hover:bg-surface-2 disabled:opacity-30 ${danger ? "hover:text-bad" : "hover:text-text"}`}
    >
      {children}
    </button>
  );
}
