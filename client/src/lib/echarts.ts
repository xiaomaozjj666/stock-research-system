/**
 * ECharts 按需引入
 * 只注册项目实际使用的图表与组件，相比 `import * as echarts from 'echarts'`（全量 ~1MB）
 * 可显著减小打包体积。
 */
import * as echarts from 'echarts/core';

// 图表
import { LineChart, BarChart, RadarChart, CandlestickChart } from 'echarts/charts';

// 组件
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  MarkLineComponent,
  TitleComponent,
  DataZoomComponent,
  AxisPointerComponent,
} from 'echarts/components';

// 渲染器
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([
  LineChart,
  BarChart,
  RadarChart,
  CandlestickChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  MarkLineComponent,
  TitleComponent,
  DataZoomComponent,
  AxisPointerComponent,
  CanvasRenderer,
]);

export default echarts;
export type { ECharts } from 'echarts/core';
