"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { AlertTriangle, Loader2 } from "lucide-react";

// DuckDB-WASM, Web Workers and IndexedDB only exist in the browser, so the studio never renders on the server.
const Studio = dynamic(() => import("./Studio"), {
  ssr: false,
  loading: ({ error }) => <LoadingScreen error={error} />,
});

export function StudioLoader() {
  return <Studio />;
}

const SLOW_MS = 15_000;

function LoadingScreen({ error }: { error?: Error | null }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), SLOW_MS);
    return () => clearTimeout(t);
  }, []);

  if (error)
    return (
      <Centered>
        <AlertTriangle className="h-6 w-6 text-bad" />
        <p className="font-medium">The studio failed to load.</p>
        <p className="max-w-md text-sm text-muted">{error.message}</p>
        <ReloadButton />
      </Centered>
    );

  return (
    <Centered>
      <Loader2 className="h-6 w-6 animate-spin text-accent" />
      <p>Starting the data engine…</p>
      {slow && (
        <>
          <p className="max-w-md text-sm text-muted">
            This is taking longer than usual. In development the first visit compiles the studio, which can take up to a
            minute. If it doesn&apos;t finish, reload the page.
          </p>
          <ReloadButton />
        </>
      )}
    </Centered>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex h-dvh flex-col items-center justify-center gap-3 px-4 text-center">{children}</div>;
}

function ReloadButton() {
  return (
    <button
      onClick={() => location.reload()}
      className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-fg"
    >
      Reload
    </button>
  );
}
