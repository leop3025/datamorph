import Link from "next/link";
import {
  ArrowRight,
  BarChart3,
  Bot,
  BrainCircuit,
  Code2,
  FlaskConical,
  Gauge,
  ScanSearch,
  ShieldCheck,
  Wand2,
} from "lucide-react";
import { Logo } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";

const FEATURES = [
  { icon: ScanSearch, title: "Auto profiling", text: "Column stats, histograms, a data quality score and warnings the moment you drop a file." },
  { icon: Wand2, title: "No-code cleaning", text: "Fix missing values, duplicates, outliers and types as a reorderable recipe with undo." },
  { icon: Code2, title: "Show me the code", text: "Every step exports as clean pandas code or a runnable Jupyter notebook." },
  { icon: BarChart3, title: "Drag-and-drop charts", text: "Drop columns onto shelves and get the right chart, suggested for you." },
  { icon: FlaskConical, title: "Statistics in plain English", text: "t-tests, ANOVA and chi-square, with results explained in plain words." },
  { icon: BrainCircuit, title: "AutoML", text: "Train and compare scikit-learn models, see what drives predictions and try what-ifs." },
  { icon: Bot, title: "Ask your data", text: "Ask questions in English. Get SQL you can read and edit, running locally." },
  { icon: Gauge, title: "Fast on big files", text: "DuckDB-WASM handles millions of rows in the browser without freezing the page." },
];

export default function Home() {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-4">
        <span className="flex items-center gap-2 font-semibold">
          <Logo /> Datamorph
        </span>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <Link href="/studio" className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-fg">
            Open studio
          </Link>
        </div>
      </header>

      <main className="flex-1">
        <section className="mx-auto max-w-4xl px-4 pb-16 pt-16 text-center md:pt-24">
          <span className="inline-flex items-center gap-1.5 rounded-full border bg-surface px-3 py-1 text-xs text-muted">
            <ShieldCheck className="h-3.5 w-3.5 text-good" /> Your data never leaves your browser
          </span>
          <h1 className="mt-6 text-4xl font-semibold tracking-tight md:text-6xl">
            Analyse any dataset.
            <br />
            <span className="text-accent">No code required.</span>
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg text-muted">
            Drop in a CSV, Excel, JSON or Parquet file, then profile, clean, visualise and model it with clicks.
            Datamorph writes the Python code for everything you do.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link
              href="/studio"
              className="inline-flex items-center gap-2 rounded-lg bg-accent px-5 py-3 font-medium text-accent-fg"
            >
              Try with sample data <ArrowRight className="h-4 w-4" />
            </Link>
            <Link href="/studio" className="rounded-lg border bg-surface px-5 py-3 font-medium hover:bg-surface-2">
              Upload your own file
            </Link>
          </div>
        </section>

        <section className="mx-auto grid max-w-6xl gap-4 px-4 pb-20 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map((f) => (
            <div key={f.title} className="rounded-xl border bg-surface p-5">
              <f.icon className="mb-3 h-5 w-5 text-accent" />
              <h3 className="font-medium">{f.title}</h3>
              <p className="mt-1 text-sm text-muted">{f.text}</p>
            </div>
          ))}
        </section>
      </main>

      <footer className="border-t py-6 text-center text-sm text-muted">
        Built with Next.js, DuckDB-WASM and ECharts · Runs entirely in your browser
      </footer>
    </div>
  );
}
