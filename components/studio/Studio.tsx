"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  BarChart3,
  Bot,
  BrainCircuit,
  Command,
  FileText,
  RotateCcw,
  FlaskConical,
  LayoutDashboard,
  Loader2,
  Plus,
  Shuffle,
  ScanSearch,
  Sparkles,
  Table2,
  Database,
  Trash2,
  Wand2,
  X,
} from "lucide-react";
import { useActiveDataset, useStudio, type Tab } from "@/lib/store/studio";
import { ImportPanel } from "@/components/upload/ImportPanel";
import { DataTable } from "@/components/data-table/DataTable";
import { ProfileView } from "@/components/profile/ProfileView";
import { RecipeWorkspace } from "@/components/cleaning/RecipeWorkspace";
import { ChartBuilder } from "@/components/chart-builder/ChartBuilder";
import { AnalyzeView } from "@/components/stats/AnalyzeView";
import { MLView } from "@/components/ml/MLView";
import { AskAI } from "@/components/ai/AskAI";
import { SqlView } from "@/components/sql/SqlView";
import { Dashboard } from "@/components/dashboard/Dashboard";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Logo } from "@/components/Logo";
import { CommandPalette } from "./CommandPalette";
import { Onboarding } from "./Onboarding";
import { Report } from "@/components/report/Report";
import { clearSession, startAutosave } from "@/lib/persist";

const TABS: {
  id: Tab | string;
  label: string;
  icon: React.ElementType;
  ready: boolean;
}[] = [
  { id: "profile", label: "Profile", icon: ScanSearch, ready: true },
  { id: "data", label: "Data", icon: Table2, ready: true },
  { id: "clean", label: "Clean", icon: Wand2, ready: true },
  { id: "transform", label: "Transform", icon: Shuffle, ready: true },
  { id: "visualize", label: "Visualise", icon: BarChart3, ready: true },
  { id: "analyze", label: "Analyse", icon: FlaskConical, ready: true },
  { id: "ml", label: "ML studio", icon: BrainCircuit, ready: true },
  { id: "ai", label: "Ask AI", icon: Bot, ready: true },
  { id: "sql", label: "Text to SQL", icon: Database, ready: true },
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard, ready: true },
];

export default function Studio() {
  const {
    datasets,
    activeId,
    tab,
    busy,
    error,
    setTab,
    setActive,
    removeDataset,
    clearError,
    reportOpen,
    setReportOpen,
  } = useStudio();
  const active = useActiveDataset();
  // Dataset count when the user opened "Add dataset"; loading a new one closes the panel.
  const [addingAt, setAddingAt] = useState<number | null>(null);
  const adding = addingAt === datasets.length;

  // Handle for end-to-end tests and power users in DevTools. Data never leaves the browser anyway.
  useEffect(() => {
    (window as unknown as { __datamorph: typeof useStudio }).__datamorph =
      useStudio;
    void startAutosave();
  }, []);

  const startFresh = async () => {
    if (
      !confirm(
        "Start fresh? This removes all datasets, recipes and dashboard widgets saved in this browser.",
      )
    )
      return;
    await clearSession();
    location.reload();
  };
  const showImport = adding || !active;

  return (
    <>
      <div
        className={`flex h-dvh flex-col print:h-auto ${reportOpen ? "print:hidden" : ""}`}
      >
        <header className="flex h-14 shrink-0 print:hidden items-center justify-between border-b bg-surface px-4">
          <Link href="/" className="flex items-center gap-2 font-semibold">
            <Logo /> Datamorph
          </Link>
          <div className="flex items-center gap-2">
            {busy && (
              <span className="flex items-center gap-2 text-sm text-muted">
                <Loader2 className="h-4 w-4 animate-spin" /> {busy}
              </span>
            )}
            <button
              onClick={() =>
                window.dispatchEvent(
                  new KeyboardEvent("keydown", { key: "k", ctrlKey: true }),
                )
              }
              className="hidden items-center gap-1 rounded-lg border px-2 py-1 text-xs text-muted hover:bg-surface-2 sm:inline-flex"
              title="Command palette"
            >
              <Command className="h-3 w-3" /> K
            </button>
            {active && (
              <button
                onClick={() => setReportOpen(true)}
                className="rounded-lg p-2 text-muted hover:bg-surface-2 hover:text-text"
                title="EDA report (print / PDF)"
                aria-label="EDA report"
              >
                <FileText className="h-4 w-4" />
              </button>
            )}
            {datasets.length > 0 && (
              <button
                onClick={startFresh}
                className="rounded-lg p-2 text-muted hover:bg-surface-2 hover:text-bad"
                title="Start fresh"
                aria-label="Start fresh"
              >
                <RotateCcw className="h-4 w-4" />
              </button>
            )}
            <ThemeToggle />
          </div>
        </header>

        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          {/* Sidebar */}
          <aside className="shrink-0 print:hidden border-b bg-surface p-3 md:w-60 md:border-r md:border-b-0">
            <div className="mb-2 flex items-center justify-between px-1">
              <span className="text-xs font-medium uppercase tracking-wide text-muted">
                Datasets
              </span>
              <button
                onClick={() => setAddingAt(datasets.length)}
                className="rounded p-1 text-muted hover:bg-surface-2 hover:text-text"
                title="Add dataset"
                aria-label="Add dataset"
              >
                <Plus className="h-4 w-4" />
              </button>
            </div>
            {datasets.length === 0 && (
              <p className="px-1 text-sm text-muted">No data yet.</p>
            )}
            <ul className="flex gap-1 overflow-x-auto md:block md:space-y-1">
              {datasets.map((d) => (
                <li key={d.id} className="group shrink-0">
                  <button
                    onClick={() => {
                      setActive(d.id);
                      setAddingAt(null);
                    }}
                    className={`flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-sm ${
                      d.id === activeId && !adding
                        ? "bg-accent-soft text-accent"
                        : "hover:bg-surface-2"
                    }`}
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium">
                        {d.name}
                      </span>
                      <span className="block text-xs text-muted">
                        {d.rowCount.toLocaleString()} × {d.columns.length}
                      </span>
                    </span>
                    <Trash2
                      className="h-3.5 w-3.5 shrink-0 text-muted opacity-0 hover:text-bad group-hover:opacity-100"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeDataset(d.id);
                      }}
                      aria-label={`Remove ${d.name}`}
                    />
                  </button>
                </li>
              ))}
            </ul>
            <div className="hidden md:block">
              <Onboarding />
            </div>
          </aside>

          {/* Main */}
          <main className="flex min-h-0 min-w-0 flex-1 flex-col">
            {error && (
              <div className="m-4 mb-0 flex items-start justify-between gap-2 rounded-lg border border-bad/40 bg-bad-soft px-4 py-2 text-sm text-bad">
                {error}
                <button onClick={clearError} aria-label="Dismiss">
                  <X className="h-4 w-4" />
                </button>
              </div>
            )}

            {showImport ? (
              <div className="overflow-auto p-4 md:p-8">
                <div className="mx-auto max-w-2xl">
                  <div className="mb-6 flex items-start justify-between">
                    <div>
                      <h1 className="text-2xl font-semibold">Add a dataset</h1>
                      <p className="text-muted">
                        Start with your own file or one of the samples.
                      </p>
                    </div>
                    {active && (
                      <button
                        onClick={() => setAddingAt(null)}
                        className="rounded p-1 text-muted hover:bg-surface-2"
                        aria-label="Close"
                      >
                        <X className="h-5 w-5" />
                      </button>
                    )}
                  </div>
                  <ImportPanel />
                </div>
              </div>
            ) : (
              active && (
                <>
                  <nav className="flex shrink-0 print:hidden gap-1 overflow-x-auto border-b bg-surface px-4">
                    {TABS.map((t) => (
                      <button
                        key={t.id}
                        disabled={!t.ready}
                        onClick={() => setTab(t.id as Tab)}
                        className={`flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm ${
                          tab === t.id
                            ? "border-accent text-accent"
                            : "border-transparent text-muted hover:text-text"
                        } disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-muted`}
                        title={t.ready ? undefined : "Coming soon"}
                      >
                        <t.icon className="h-4 w-4" />
                        {t.label}
                        {!t.ready && <Sparkles className="h-3 w-3" />}
                      </button>
                    ))}
                  </nav>
                  <div className="min-h-0 flex-1 p-4">
                    {tab === "data" ? (
                      <DataTable
                        key={`${active.id}:${active.version}`}
                        dataset={active}
                      />
                    ) : tab === "clean" || tab === "transform" ? (
                      <RecipeWorkspace dataset={active} group={tab} />
                    ) : tab === "visualize" ? (
                      <ChartBuilder key={active.id} dataset={active} />
                    ) : tab === "analyze" ? (
                      <AnalyzeView key={active.id} dataset={active} />
                    ) : tab === "ml" ? (
                      <MLView key={active.id} dataset={active} />
                    ) : tab === "sql" ? (
                      <SqlView dataset={active} />
                    ) : tab === "ai" ? (
                      <AskAI key={active.id} dataset={active} />
                    ) : tab === "dashboard" ? (
                      <Dashboard />
                    ) : (
                      <div className="h-full overflow-auto">
                        <ProfileView dataset={active} />
                      </div>
                    )}
                  </div>
                </>
              )
            )}
          </main>
        </div>
      </div>
      <CommandPalette onAddData={() => setAddingAt(datasets.length)} />
      {reportOpen && active && <Report dataset={active} />}
    </>
  );
}
