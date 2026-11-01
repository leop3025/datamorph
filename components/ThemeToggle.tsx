"use client";

import { useSyncExternalStore } from "react";
import { Monitor, Moon, Sun } from "lucide-react";

type Theme = "system" | "light" | "dark";
const ORDER: Theme[] = ["system", "light", "dark"];
const ICON = { system: Monitor, light: Sun, dark: Moon };

// The <html data-theme> attribute is the source of truth (set before paint by lib/theme.ts).
function subscribe(onChange: () => void) {
  const mo = new MutationObserver(onChange);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => mo.disconnect();
}
const getSnapshot = () => (document.documentElement.getAttribute("data-theme") as Theme | null) ?? "system";
const getServerSnapshot = (): Theme => "system";

export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const next = () => {
    const t = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length];
    if (t === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", t);
    try {
      localStorage.setItem("theme", t);
    } catch {}
  };

  const Icon = ICON[theme];
  return (
    <button
      onClick={next}
      className="rounded-lg p-2 text-muted hover:bg-surface-2 hover:text-text"
      title={`Theme: ${theme}`}
      aria-label={`Theme: ${theme}. Click to change.`}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}
