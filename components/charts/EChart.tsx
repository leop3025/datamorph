"use client";

import { useEffect, useRef, useState } from "react";
import { echarts, type EChartsOption } from "@/lib/charts/echarts";

export function EChart({
  option,
  className,
  style,
}: {
  option: EChartsOption;
  className?: string;
  style?: React.CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const instance = echarts.init(ref.current);
    chart.current = instance;
    const ro = new ResizeObserver(() => instance.resize());
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      instance.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    chart.current?.setOption(option, true);
  }, [option]);

  return <div ref={ref} className={className} style={style} />;
}

/** Read the current theme tokens so charts match light/dark mode. */
export function useThemeColors() {
  const [colors, setColors] = useState(readColors);
  useEffect(() => {
    const update = () => setColors(readColors());
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", update);
    const mo = new MutationObserver(update);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      mq.removeEventListener("change", update);
      mo.disconnect();
    };
  }, []);
  return colors;
}

function readColors() {
  if (typeof window === "undefined")
    return { text: "#16181d", muted: "#646b78", border: "#e3e5e8", surface: "#fff", accent: "#4f46e5", bad: "#b91c1c" };
  const s = getComputedStyle(document.documentElement);
  const v = (name: string) => s.getPropertyValue(name).trim();
  return {
    text: v("--text"),
    muted: v("--muted"),
    border: v("--border"),
    surface: v("--surface"),
    accent: v("--accent"),
    bad: v("--bad"),
  };
}
