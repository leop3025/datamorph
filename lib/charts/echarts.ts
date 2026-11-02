"use client";

// Tree-shaken ECharts: register only what the app uses to keep the bundle small.
import * as echarts from "echarts/core";
import { BarChart, BoxplotChart, HeatmapChart, LineChart, PieChart, ScatterChart, TreemapChart } from "echarts/charts";
import {
  DatasetComponent,
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
  VisualMapComponent,
} from "echarts/components";
import { CanvasRenderer, SVGRenderer } from "echarts/renderers";

echarts.use([
  BarChart,
  BoxplotChart,
  HeatmapChart,
  LineChart,
  PieChart,
  ScatterChart,
  TreemapChart,
  DatasetComponent,
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
  VisualMapComponent,
  CanvasRenderer,
  SVGRenderer,
]);

export { echarts };
export type EChartsOption = echarts.EChartsCoreOption;
