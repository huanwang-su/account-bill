/** Register only chart types/components used by this application. */
import { use, init } from "echarts/core";
import { BarChart, LineChart, PieChart, SankeyChart } from "echarts/charts";
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  TitleComponent,
  DataZoomComponent,
  MarkLineComponent,
  MarkPointComponent,
  MarkAreaComponent,
  DatasetComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
use([
  BarChart,
  LineChart,
  PieChart,
  SankeyChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  TitleComponent,
  DataZoomComponent,
  MarkLineComponent,
  MarkPointComponent,
  MarkAreaComponent,
  DatasetComponent,
  CanvasRenderer,
]);
export { init };
export type { EChartsType as ECharts } from "echarts/core";
export type { EChartsOption } from "echarts";
