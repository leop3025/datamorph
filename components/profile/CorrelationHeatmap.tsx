"use client";

import { useMemo } from "react";
import { EChart, useThemeColors } from "@/components/charts/EChart";
import type { Profile } from "@/lib/profile/profile";

export function CorrelationHeatmap({ data }: { data: NonNullable<Profile["correlation"]> }) {
  const theme = useThemeColors();
  const option = useMemo(() => {
    const cells: [number, number, number | string][] = [];
    data.matrix.forEach((row, i) =>
      row.forEach((v, j) => cells.push([j, i, v === null ? "-" : Number(v.toFixed(2))])),
    );
    return {
      tooltip: {
        formatter: (p: { value: [number, number, number | string] }) =>
          `${data.columns[p.value[1]]} × ${data.columns[p.value[0]]}<br/><b>r = ${p.value[2]}</b>`,
      },
      grid: { left: 8, right: 70, top: 8, bottom: 8, containLabel: true },
      xAxis: {
        type: "category",
        data: data.columns,
        axisLabel: { color: theme.muted, rotate: 40, fontSize: 11 },
        axisLine: { lineStyle: { color: theme.border } },
        splitArea: { show: false },
      },
      yAxis: {
        type: "category",
        data: data.columns,
        inverse: true,
        axisLabel: { color: theme.muted, fontSize: 11 },
        axisLine: { lineStyle: { color: theme.border } },
      },
      visualMap: {
        min: -1,
        max: 1,
        calculable: true,
        orient: "vertical",
        right: 0,
        top: "middle",
        textStyle: { color: theme.muted },
        // Diverging scale: blue (negative) → neutral → orange (positive)
        inRange: { color: ["#2563eb", "#93c5fd", theme.surface, "#fdba74", "#ea580c"] },
      },
      series: [
        {
          type: "heatmap",
          data: cells,
          label: { show: data.columns.length <= 10, color: theme.text, fontSize: 11 },
          itemStyle: { borderColor: theme.surface, borderWidth: 2 },
          emphasis: { itemStyle: { borderColor: theme.text, borderWidth: 1 } },
        },
      ],
    };
  }, [data, theme]);

  const height = Math.max(280, data.columns.length * 34 + 90);
  return <EChart option={option} className="w-full" style={{ height }} />;
}
