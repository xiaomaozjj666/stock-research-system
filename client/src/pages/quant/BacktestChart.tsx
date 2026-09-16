import { useMemo } from 'react';
// 图表统一走 EChart 封装：init / setOption / ResizeObserver / dispose 由它负责，
// 这里只产出 option 与指标卡（此前本组件自己 init + 监听 window.resize，
// 既与 EChart 并行维护两套生命周期，又在 [data] 变化时重建整个实例）
import EChart from '../../components/EChart';
import { useReducedMotion } from '../../hooks/useReducedMotion';
import { CHART_COLOR, signCls } from '../../lib/colors';
import type { BacktestResult } from './types';

interface Props {
  data: BacktestResult;
}

// 后端返回的值已经是百分比形式（如 12.34 表示 12.34%），直接加 % 即可
function formatPct(v: number): string {
  return v.toFixed(2) + '%';
}

/**
 * 指标卡着色口径
 * - val-positive / val-negative：数值方向（A 股：红涨绿跌）
 * - val-warn：风险量（最大回撤）
 * - val-neutral：没有方向的量（交易次数）与阈值型质量指标（夏普 / 胜率）
 */
type MetricTone = 'val-positive' | 'val-negative' | 'val-neutral' | 'val-warn';

export default function BacktestChart({ data }: Props) {
  const reducedMotion = useReducedMotion();

  const option = useMemo(() => {
    const dates = data.equityCurve.map((p) => p.date);
    const strategyVals = data.equityCurve.map((p) => p.value);
    const benchmarkVals = data.benchmark.map((p) => p.value);

    return {
      backgroundColor: 'transparent',
      // 此前未显式声明 animation，走 ECharts 默认（开）。
      // 系统开启「减少动态效果」时关掉入场动画：canvas 动画不受 CSS 媒体查询约束。
      animation: !reducedMotion,
      grid: { left: 60, right: 20, top: 30, bottom: 40 },
      tooltip: {
        trigger: 'axis',
        backgroundColor: CHART_COLOR.tooltipBg,
        borderColor: CHART_COLOR.border,
        textStyle: { color: CHART_COLOR.textPrimary, fontSize: 12 },
        formatter: (params: unknown) => {
          const p = params as {
            axisValue: string;
            seriesName: string;
            value: number;
            color: string;
          }[];
          if (!Array.isArray(p)) return '';
          const date = p[0]?.axisValue ?? '';
          const rows = p
            .map(
              (s) =>
                `<span style="color:${s.color}">●</span> ${s.seriesName}: <b>${s.value?.toFixed(4)}</b>`,
            )
            .join('<br/>');
          return `${date}<br/>${rows}`;
        },
      },
      legend: {
        data: ['策略净值', '基准(买入持有)'],
        top: 0,
        textStyle: { color: CHART_COLOR.textSecondary, fontSize: 12 },
      },
      xAxis: {
        type: 'category',
        data: dates,
        axisLine: { lineStyle: { color: CHART_COLOR.border } },
        axisLabel: { color: CHART_COLOR.textMuted, fontSize: 11 },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value',
        axisLine: { show: false },
        axisLabel: {
          color: CHART_COLOR.textMuted,
          fontSize: 11,
          formatter: (v: number) => v.toFixed(2),
        },
        splitLine: { lineStyle: { color: CHART_COLOR.border } },
      },
      series: [
        {
          name: '策略净值',
          type: 'line',
          data: strategyVals,
          smooth: true,
          symbol: 'none',
          lineStyle: { color: CHART_COLOR.accent, width: 2 },
          itemStyle: { color: CHART_COLOR.accent },
        },
        {
          name: '基准(买入持有)',
          type: 'line',
          data: benchmarkVals,
          smooth: true,
          symbol: 'none',
          lineStyle: { color: CHART_COLOR.textMuted, width: 1.5, type: 'dashed' },
          itemStyle: { color: CHART_COLOR.textMuted },
        },
      ],
    };
  }, [data, reducedMotion]);

  const metrics: { label: string; value: string; tone: MetricTone }[] = [
    { label: '总收益率', value: formatPct(data.totalReturn), tone: signCls(data.totalReturn) },
    {
      label: '年化收益',
      value: formatPct(data.annualizedReturn),
      tone: signCls(data.annualizedReturn),
    },
    // 夏普/胜率是「质量阈值」判定（>=1 / >=50% 算好），不是价格方向：
    // 用涨跌色表达好坏会被读成「赚/亏」，一律走中性色
    { label: '夏普比率', value: data.sharpeRatio.toFixed(2), tone: 'val-neutral' },
    // 最大回撤恒为负值，此前硬编码 positive:false 会永远渲染成绿色（= 涨），
    // 与「红涨绿跌」直接冲突；回撤是风险量，改用琥珀色
    { label: '最大回撤', value: formatPct(data.maxDrawdown), tone: 'val-warn' },
    { label: '胜率', value: formatPct(data.winRate), tone: 'val-neutral' },
    // 交易次数没有方向，硬编码 positive:true 会永远显示红色
    { label: '交易次数', value: String(data.tradeCount), tone: 'val-neutral' },
  ];

  return (
    <div className="quant-backtest">
      {data.newsAware && (
        <div className="backtest-news-badge">
          含最新消息情绪叠加（新闻姿态 {((data.newsPosture ?? 1) * 100).toFixed(0)}% 仓位）
        </div>
      )}
      {data.factorAware && (
        <div className="backtest-news-badge backtest-factor-badge">
          含组合 alpha 信号叠加（综合方向 {data.factorDirection}
          {typeof data.factorPosture === 'number' &&
            `，姿态 ${((data.factorPosture ?? 1) * 100).toFixed(0)}% 仓位`}
          ）
        </div>
      )}
      <div className="quant-metrics">
        {metrics.map((m) => (
          <div key={m.label} className="quant-metric-card">
            {/* 数值方向色走 .val-* 令牌（与量化面板其它表格同一口径），
                字号/字重仍由 .quant-metric-value 提供 */}
            <div className={`quant-metric-value ${m.tone}`}>{m.value}</div>
            <div className="quant-metric-label">{m.label}</div>
          </div>
        ))}
      </div>
      <div className="quant-chart-card">
        <h4 className="quant-chart-title">权益曲线</h4>
        {/* .quant-chart 自带 width:100%/height:320px，与原 div 完全一致 */}
        <EChart option={option} className="quant-chart" />
      </div>
    </div>
  );
}
