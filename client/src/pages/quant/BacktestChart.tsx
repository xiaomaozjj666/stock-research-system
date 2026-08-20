import { useEffect, useRef } from 'react';
import echarts from '../../lib/echarts';
import type { BacktestResult } from './types';

interface Props {
  data: BacktestResult;
}

// 后端返回的值已经是百分比形式（如 12.34 表示 12.34%），直接加 % 即可
function formatPct(v: number): string {
  return v.toFixed(2) + '%';
}

export default function BacktestChart({ data }: Props) {
  const chartRef = useRef<HTMLDivElement>(null);
  const chartInstance = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    if (!chartRef.current) return;
    chartInstance.current = echarts.init(chartRef.current, undefined, { renderer: 'canvas' });

    const dates = data.equityCurve.map((p) => p.date);
    const strategyVals = data.equityCurve.map((p) => p.value);
    const benchmarkVals = data.benchmark.map((p) => p.value);

    chartInstance.current.setOption({
      backgroundColor: 'transparent',
      grid: { left: 60, right: 20, top: 30, bottom: 40 },
      tooltip: {
        trigger: 'axis',
        backgroundColor: 'rgba(22,22,22,0.95)',
        borderColor: '#2a2a2a',
        textStyle: { color: '#f0f0f0', fontSize: 12 },
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
        textStyle: { color: '#a0a0a0', fontSize: 12 },
      },
      xAxis: {
        type: 'category',
        data: dates,
        axisLine: { lineStyle: { color: '#2a2a2a' } },
        axisLabel: { color: '#666', fontSize: 11 },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value',
        axisLine: { show: false },
        axisLabel: { color: '#666', fontSize: 11, formatter: (v: number) => v.toFixed(2) },
        splitLine: { lineStyle: { color: '#1e1e1e' } },
      },
      series: [
        {
          name: '策略净值',
          type: 'line',
          data: strategyVals,
          smooth: true,
          symbol: 'none',
          lineStyle: { color: '#4c8dff', width: 2 },
          itemStyle: { color: '#4c8dff' },
        },
        {
          name: '基准(买入持有)',
          type: 'line',
          data: benchmarkVals,
          smooth: true,
          symbol: 'none',
          lineStyle: { color: '#666', width: 1.5, type: 'dashed' },
          itemStyle: { color: '#666' },
        },
      ],
    });

    const handleResize = () => chartInstance.current?.resize();
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      chartInstance.current?.dispose();
    };
  }, [data]);

  const metrics = [
    { label: '总收益率', value: formatPct(data.totalReturn), positive: data.totalReturn >= 0 },
    {
      label: '年化收益',
      value: formatPct(data.annualizedReturn),
      positive: data.annualizedReturn >= 0,
    },
    { label: '夏普比率', value: data.sharpeRatio.toFixed(2), positive: data.sharpeRatio >= 1 },
    { label: '最大回撤', value: formatPct(data.maxDrawdown), positive: false },
    { label: '胜率', value: formatPct(data.winRate), positive: data.winRate >= 50 },
    { label: '交易次数', value: String(data.tradeCount), positive: true },
  ];

  return (
    <div className="quant-backtest">
      {data.newsAware && (
        <div className="backtest-news-badge">
          含最新消息情绪叠加（新闻姿态 {((data.newsPosture ?? 1) * 100).toFixed(0)}% 仓位）
        </div>
      )}
      <div className="quant-metrics">
        {metrics.map((m) => (
          <div key={m.label} className="quant-metric-card">
            <div className={`quant-metric-value ${m.positive ? 'positive' : 'negative'}`}>
              {m.value}
            </div>
            <div className="quant-metric-label">{m.label}</div>
          </div>
        ))}
      </div>
      <div className="quant-chart-card">
        <h4 className="quant-chart-title">权益曲线</h4>
        <div ref={chartRef} className="quant-chart" />
      </div>
    </div>
  );
}
