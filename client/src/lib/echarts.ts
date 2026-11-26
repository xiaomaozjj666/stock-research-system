/**
 * ECharts 按需引入
 * 只注册项目实际使用的图表与组件，相比 `import * as echarts from 'echarts'`（全量 ~1MB）
 * 可显著减小打包体积。
 */
import * as echarts from 'echarts/core';

// 图表（雷达图已改为轻量 SVG，见 components/ScoreRadar.tsx，不再需要 radar 坐标系）
import { LineChart, BarChart, CandlestickChart } from 'echarts/charts';

// 组件
import {
  GridComponent,
  TooltipComponent,
  // 只用到普通图例（全仓无 type:'scroll' 的滚动图例），用 LegendPlainComponent
  // 而不是 LegendComponent（后者会连带打入滚动图例，实测多 5.74 kB）。
  LegendPlainComponent,
  MarkLineComponent,
  DataZoomComponent,
} from 'echarts/components';

// 渲染器
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([
  LineChart,
  BarChart,
  CandlestickChart,
  GridComponent,
  TooltipComponent,
  LegendPlainComponent,
  MarkLineComponent,
  DataZoomComponent,
  // AxisPointerComponent 不再显式注册：TooltipComponent 内部已 install 同一模块，
  // 重复 use() 不会增加体积，留着只会让人误以为它是独立依赖。
  CanvasRenderer,
]);

export default echarts;
export type { ECharts } from 'echarts/core';
