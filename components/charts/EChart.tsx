"use client";

import { useEffect, useRef, useState } from "react";
import { echarts, type EChartsOption } from "@/lib/charts/echarts";

export function EChart({
  option,
  className,
  style,
  onInit,
  onClick,
}: {
  option: EChartsOption;
  className?: string;
  style?: React.CSSProperties;
  /** Receives the ECharts instance (e.g. to export an image) */
  onInit?: (chart: echarts.ECharts | null) => void;
  /** Click on a data mark (bar, slice, point) */
  onClick?: (params: { name: string; seriesName?: string; value: unknown }) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const click = useRef(onClick);
  useEffect(() => {
    click.current = onClick;
  });

  useEffect(() => {
    if (!ref.current) return;
    const instance = echarts.init(ref.current);
    chart.current = instance;
    onInit?.(instance);
    instance.on("click", (p) => click.current?.(p as { name: string; seriesName?: string; value: unknown }));
    const ro = new ResizeObserver(() => instance.resize());
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      instance.dispose();
      chart.current = null;
      onInit?.(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

export type ThemeColors = ReturnType<typeof readColors>;

const FALLBACK_SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];

function readColors() {
  if (typeof window === "undefined")
    return {
      text: "#16181d",
      muted: "#646b78",
      border: "#e3e5e8",
      grid: "#e1e0d9",
      surface: "#fff",
      accent: "#4f46e5",
      bad: "#b91c1c",
      series: FALLBACK_SERIES,
      other: "#898781",
      divNeg: "#2a78d6",
      divMid: "#f0efec",
      divPos: "#e34948",
    };
  const s = getComputedStyle(document.documentElement);
  const v = (name: string) => s.getPropertyValue(name).trim();
  return {
    text: v("--text"),
    muted: v("--muted"),
    border: v("--border"),
    grid: v("--grid"),
    surface: v("--surface"),
    accent: v("--accent"),
    bad: v("--bad"),
    series: Array.from({ length: 8 }, (_, i) => v(`--series-${i + 1}`)),
    other: v("--series-other"),
    divNeg: v("--div-neg"),
    divMid: v("--div-mid"),
    divPos: v("--div-pos"),
  };
}
