"use client";

import { useRef, useState } from "react";
import { ClipboardPaste, Database, Link2, Upload } from "lucide-react";
import { useStudio } from "@/lib/store/studio";
import { SAMPLES } from "@/lib/data/samples";

export function ImportPanel({ compact = false }: { compact?: boolean }) {
  const { addFile, addUrl, addText, busy } = useStudio();
  const [dragging, setDragging] = useState(false);
  const [mode, setMode] = useState<"none" | "url" | "paste">("none");
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);

  const onFiles = async (files: FileList | null) => {
    for (const f of Array.from(files ?? [])) await addFile(f);
  };

  return (
    <div className="space-y-6">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          onFiles(e.dataTransfer.files);
        }}
        onClick={() => input.current?.click()}
        className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed text-center transition-colors ${
          compact ? "px-4 py-8" : "px-6 py-14"
        } ${dragging ? "border-accent bg-accent-soft" : "border-border bg-surface hover:border-accent/60"}`}
      >
        <Upload className="mb-3 h-8 w-8 text-accent" />
        <p className="font-medium">Drop files here or click to browse</p>
        <p className="mt-1 text-sm text-muted">CSV, TSV, JSON / NDJSON, Excel (.xlsx), Parquet</p>
        <p className="mt-3 text-xs text-muted">Files are processed in your browser and never uploaded.</p>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          accept=".csv,.tsv,.txt,.json,.ndjson,.jsonl,.parquet,.xlsx,.xls"
          onChange={(e) => {
            onFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => setMode(mode === "url" ? "none" : "url")}
          className="inline-flex items-center gap-2 rounded-lg border bg-surface px-3 py-2 text-sm hover:bg-surface-2"
        >
          <Link2 className="h-4 w-4" /> From URL / Google Sheet
        </button>
        <button
          onClick={() => setMode(mode === "paste" ? "none" : "paste")}
          className="inline-flex items-center gap-2 rounded-lg border bg-surface px-3 py-2 text-sm hover:bg-surface-2"
        >
          <ClipboardPaste className="h-4 w-4" /> Paste data
        </button>
      </div>

      {mode === "url" && (
        <form
          className="space-y-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (url.trim()) await addUrl(url);
          }}
        >
          <div className="flex gap-2">
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://…/data.csv or a public Google Sheets link"
              className="flex-1 rounded-lg border bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
            />
            <button disabled={!!busy} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-fg disabled:opacity-50">
              Load
            </button>
          </div>
          <p className="text-xs text-muted">
            The server must allow cross-origin downloads (CORS). Google Sheets must be shared as &quot;Anyone with the link&quot;.
          </p>
        </form>
      )}

      {mode === "paste" && (
        <form
          className="space-y-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (text.trim()) await addText(text);
          }}
        >
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={6}
            placeholder={"name,age,city\nAsha,29,Chennai\nRavi,34,Madurai"}
            className="w-full rounded-lg border bg-surface px-3 py-2 font-mono text-sm outline-none focus:border-accent"
          />
          <button disabled={!!busy} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-fg disabled:opacity-50">
            Load pasted data
          </button>
          <p className="text-xs text-muted">Comma, tab or semicolon separated, with a header row. Copying from Excel works.</p>
        </form>
      )}

      <div>
        <h3 className="mb-2 flex items-center gap-2 text-sm font-medium text-muted">
          <Database className="h-4 w-4" /> Or try a sample dataset
        </h3>
        <div className={`grid gap-2 ${compact ? "grid-cols-1" : "sm:grid-cols-2"}`}>
          {SAMPLES.map((s) => (
            <button
              key={s.file}
              disabled={!!busy}
              onClick={() => addUrl(`/samples/${s.file}`, s.file)}
              className="rounded-lg border bg-surface p-3 text-left transition-colors hover:border-accent disabled:opacity-50"
            >
              <div className="text-sm font-medium">{s.title}</div>
              <div className="text-xs text-muted">{s.description}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
