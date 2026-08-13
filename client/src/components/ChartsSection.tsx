import ReactEChartsCoreDefault from 'echarts-for-react/lib/core';
import type { ComponentType, CSSProperties } from 'react';
import echarts from '../lib/echarts';

// echarts-for-react@3.0.7 的声明基于 React 18 的 Component 类型，与 React 19 的 JSX 类型不兼容
// （运行时正常）。这里做最小类型桥接，使其可作为 JSX 组件使用。
// option 采用 unknown：ECharts 6 的 EChartsOption 类型较严格，内联配置对象（type 字面量被推断为
// string 等）易触发类型不匹配；运行时渲染不受影响。
const ReactEChartsCore = ReactEChartsCoreDefault as unknown as ComponentType<{
  echarts: typeof import('../lib/echarts').default;
  option: unknown;
  style?: CSSProperties;
  notMerge?: boolean;
  lazyUpdate?: boolean;
  theme?: string | object;
  onChartReady?: (instance: unknown) => void;
  onEvents?: Record<string, (params: unknown) => void>;
}>;

interface StockData {
  stock_name?: string;
  finance_metrics?: {
    years?: string[];
    revenue?: number[];
    netProfit?: number[];
    grossMargin?: number[];
    netMargin?: number[];
    roe?: number[];
  };
  valuation?: {
    pe?: number;
    historicalPE?: { year: string; pe: number }[];
    peerComparison?: { name: string; code: string; pe: number }[];
  };
  score_detail?: {
    profit_quality: number;
    growth: number;
    valuation: number;
    industry_boom: number;
    risk_deduction: number;
  };
}

interface ChartsSectionProps {
  data: StockData;
}

// Design system colors
const accent = '#2dd4bf';
const accentDim = 'rgba(45, 212, 191, 0.12)';
const colorInfo = '#60a5fa';
const colorPositive = '#34d399';
const colorWarning = '#fbbf24';
const textSecondary = '#a0a0a0';
const textMuted = '#666666';
const borderDefault = '#2a2a2a';
const transparent = 'transparent';

const chartTextStyle = { color: textSecondary };

export default function ChartsSection({ data }: ChartsSectionProps) {
  const years = data.finance_metrics?.years || [];
  const revenue = data.finance_metrics?.revenue || [];
  const netProfit = data.finance_metrics?.netProfit || [];
  const grossMargin = data.finance_metrics?.grossMargin || [];
  const netMargin = data.finance_metrics?.netMargin || [];
  const roe = data.finance_metrics?.roe || [];
  const pe = data.valuation?.pe;
  const historicalPE = data.valuation?.historicalPE || [];
  const peerComparison = data.valuation?.peerComparison || [];
  const scoreDetail = data.score_detail;

  // 1. Revenue & Profit Trend
  const revenueChart = {
    backgroundColor: transparent,
    textStyle: chartTextStyle,
    animation: true,
    animationDuration: 1500,
    animationEasing: 'cubicOut' as const,
    tooltip: { trigger: 'axis' as const },
    legend: { data: ['营业收入', '净利润'], textStyle: chartTextStyle, top: 0 },
    grid: { left: 60, right: 60, top: 40, bottom: 30 },
    xAxis: {
      type: 'category' as const,
      data: years,
      axisLine: { lineStyle: { color: borderDefault } },
      axisLabel: chartTextStyle,
    },
    yAxis: [
      {
        type: 'value' as const,
        name: '营收(亿)',
        nameTextStyle: chartTextStyle,
        axisLabel: chartTextStyle,
        splitLine: { lineStyle: { color: borderDefault, type: 'dashed' } },
      },
      {
        type: 'value' as const,
        name: '净利润(亿)',
        nameTextStyle: chartTextStyle,
        axisLabel: chartTextStyle,
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: '营业收入',
        type: 'line',
        data: revenue,
        smooth: true,
        lineStyle: { color: accent, width: 2 },
        itemStyle: { color: accent },
        areaStyle: {
          color: {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(45,212,191,0.2)' },
              { offset: 1, color: 'rgba(45,212,191,0.02)' },
            ],
          },
        },
      },
      {
        name: '净利润',
        type: 'line',
        yAxisIndex: 1,
        data: netProfit,
        smooth: true,
        lineStyle: { color: colorInfo, width: 2 },
        itemStyle: { color: colorInfo },
        areaStyle: {
          color: {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(96,165,250,0.2)' },
              { offset: 1, color: 'rgba(96,165,250,0.02)' },
            ],
          },
        },
      },
    ],
  };

  // 2. Profitability
  const profitChart = {
    backgroundColor: transparent,
    textStyle: chartTextStyle,
    animation: true,
    animationDuration: 1500,
    animationEasing: 'cubicOut' as const,
    tooltip: {
      trigger: 'axis' as const,
      formatter: (params: { seriesName: string; value: number; marker: string }[]) => {
        let s = `<b>${params[0]?.seriesName || ''}</b><br/>`;
        params.forEach((p: { seriesName: string; value: number; marker: string }) => {
          s += `${p.marker} ${p.seriesName}: ${p.value}%<br/>`;
        });
        return s;
      },
    },
    legend: { data: ['毛利率', '净利率', 'ROE'], textStyle: chartTextStyle, top: 0 },
    grid: { left: 50, right: 20, top: 40, bottom: 30 },
    xAxis: {
      type: 'category' as const,
      data: years,
      axisLine: { lineStyle: { color: borderDefault } },
      axisLabel: chartTextStyle,
    },
    yAxis: {
      type: 'value' as const,
      axisLabel: { ...chartTextStyle, formatter: '{value}%' },
      splitLine: { lineStyle: { color: borderDefault, type: 'dashed' } },
    },
    series: [
      {
        name: '毛利率',
        type: 'line',
        data: grossMargin,
        smooth: true,
        lineStyle: { color: colorPositive, width: 2 },
        itemStyle: { color: colorPositive },
      },
      {
        name: '净利率',
        type: 'line',
        data: netMargin,
        smooth: true,
        lineStyle: { color: colorInfo, width: 2 },
        itemStyle: { color: colorInfo },
      },
      {
        name: 'ROE',
        type: 'line',
        data: roe,
        smooth: true,
        lineStyle: { color: colorWarning, width: 2 },
        itemStyle: { color: colorWarning },
      },
    ],
  };

  // 3. Peer PE Bar
  const peerNames = [data.stock_name || '标的', ...peerComparison.map((p) => p.name)];
  const peerPEs = [pe || 0, ...peerComparison.map((p) => p.pe)];
  const peerColors = peerPEs.map((_, i) => (i === 0 ? accent : textMuted));
  const peerChart = {
    backgroundColor: transparent,
    textStyle: chartTextStyle,
    animation: true,
    animationDuration: 1500,
    animationEasing: 'cubicOut' as const,
    tooltip: { trigger: 'axis' as const },
    grid: { left: 50, right: 20, top: 20, bottom: 40 },
    xAxis: {
      type: 'category' as const,
      data: peerNames,
      axisLine: { lineStyle: { color: borderDefault } },
      axisLabel: { ...chartTextStyle, fontSize: 11 },
    },
    yAxis: {
      type: 'value' as const,
      name: 'PE',
      nameTextStyle: chartTextStyle,
      axisLabel: chartTextStyle,
      splitLine: { lineStyle: { color: borderDefault, type: 'dashed' } },
    },
    series: [
      {
        type: 'bar',
        data: peerPEs.map((v, i) => ({
          value: v,
          itemStyle: { color: peerColors[i], borderRadius: [4, 4, 0, 0] },
        })),
        barWidth: '40%',
      },
    ],
  };

  // 4. Radar
  const radarChart = {
    backgroundColor: transparent,
    textStyle: chartTextStyle,
    animation: true,
    animationDuration: 1500,
    tooltip: {},
    radar: {
      indicator: [
        { name: '盈利质量', max: 20 },
        { name: '成长性', max: 20 },
        { name: '估值性价比', max: 20 },
        { name: '行业景气度', max: 20 },
        { name: '风险水平', max: 20 },
      ],
      shape: 'polygon' as const,
      axisName: { color: textSecondary, fontSize: 12 },
      splitArea: { areaStyle: { color: ['rgba(42,42,42,0.1)', 'rgba(42,42,42,0.2)'] } },
      axisLine: { lineStyle: { color: borderDefault } },
      splitLine: { lineStyle: { color: borderDefault } },
    },
    series: [
      {
        type: 'radar',
        data: [
          {
            value: scoreDetail
              ? [
                  scoreDetail.profit_quality,
                  scoreDetail.growth,
                  scoreDetail.valuation,
                  scoreDetail.industry_boom,
                  scoreDetail.risk_deduction,
                ]
              : [0, 0, 0, 0, 0],
            name: '综合评分',
            areaStyle: { color: accentDim },
            lineStyle: { color: accent, width: 2 },
            itemStyle: { color: accent },
          },
        ],
      },
    ],
  };

  // 5. Historical PE
  const peYears = historicalPE.map((p) => p.year);
  const peValues = historicalPE.map((p) => p.pe);
  const peChart = {
    backgroundColor: transparent,
    textStyle: chartTextStyle,
    animation: true,
    animationDuration: 1500,
    animationEasing: 'cubicOut' as const,
    tooltip: { trigger: 'axis' as const },
    grid: { left: 50, right: 20, top: 20, bottom: 30 },
    xAxis: {
      type: 'category' as const,
      data: peYears,
      axisLine: { lineStyle: { color: borderDefault } },
      axisLabel: chartTextStyle,
    },
    yAxis: {
      type: 'value' as const,
      name: 'PE',
      nameTextStyle: chartTextStyle,
      axisLabel: chartTextStyle,
      splitLine: { lineStyle: { color: borderDefault, type: 'dashed' } },
    },
    series: [
      {
        type: 'line',
        data: peValues,
        smooth: true,
        lineStyle: { color: accent, width: 2 },
        itemStyle: { color: accent },
        areaStyle: {
          color: {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(45,212,191,0.15)' },
              { offset: 1, color: 'rgba(45,212,191,0.02)' },
            ],
          },
        },
        markLine: pe
          ? {
              silent: true,
              data: [
                {
                  yAxis: pe,
                  label: { formatter: `当前 ${pe}`, color: '#f87171', fontSize: 11 },
                  lineStyle: { color: '#f87171', type: 'dashed' as const },
                },
              ],
            }
          : undefined,
      },
    ],
  };

  const hasFinanceData = years.length > 0;
  const hasPeData = historicalPE.length > 0;
  const hasPeerData = peerComparison.length > 0;
  const hasRadar = scoreDetail !== undefined;

  if (!hasFinanceData && !hasPeData && !hasPeerData && !hasRadar) return null;

  return (
    <div className="card">
      <div className="section-title">可视化分析</div>
      <div className="charts-grid">
        {hasFinanceData && (
          <div className="chart-card">
            <h4>营收与利润趋势</h4>
            <ReactEChartsCore echarts={echarts} option={revenueChart} style={{ height: 280 }} />
          </div>
        )}
        {hasFinanceData && (
          <div className="chart-card">
            <h4>盈利能力指标</h4>
            <ReactEChartsCore echarts={echarts} option={profitChart} style={{ height: 280 }} />
          </div>
        )}
        {hasPeerData && (
          <div className="chart-card">
            <h4>同业 PE 对比</h4>
            <ReactEChartsCore echarts={echarts} option={peerChart} style={{ height: 280 }} />
          </div>
        )}
        {hasRadar && (
          <div className="chart-card">
            <h4>五维度雷达图</h4>
            <ReactEChartsCore echarts={echarts} option={radarChart} style={{ height: 280 }} />
          </div>
        )}
        {hasPeData && (
          <div className="chart-card">
            <h4>历史 PE 走势</h4>
            <ReactEChartsCore echarts={echarts} option={peChart} style={{ height: 280 }} />
          </div>
        )}
      </div>
    </div>
  );
}
