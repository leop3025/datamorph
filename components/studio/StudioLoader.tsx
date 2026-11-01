"use client";

import dynamic from "next/dynamic";
import { Loader2 } from "lucide-react";

// DuckDB-WASM, Web Workers and IndexedDB only exist in the browser, so the studio never renders on the server.
const Studio = dynamic(() => import("./Studio"), {
  ssr: false,
  loading: () => (
    <div className="flex h-dvh items-center justify-center gap-2 text-muted">
      <Loader2 className="h-5 w-5 animate-spin" /> Starting the data engine…
    </div>
  ),
});

export function StudioLoader() {
  return <Studio />;
}
