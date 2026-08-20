import { useMemo, useState } from 'react';
import EChart from './EChart';
import type { PricePoint } from '../types';
import {
  aggregateCandles,
  computeMACD,
  computeMA,
  type Candle,
  type Period,
} from './trendMath';

interface PriceTrendChartProps {
  data: PricePoint[];
  stockName?: string;
}

// 涨跌配色（A 股惯例：红涨 / 绿跌）
const UP = '#ef232a';
const DOWN = '#14b143';

// 均线配色（在深色背景上区分度高，且不与原涨跌色冲突）
const MA_COLORS: Record<number, string> = {
  5: '#f5c542', // 金
  10: '#36cfff', // 青
  20: '#ff7ad9', // 粉
  60: '#9b6bff', // 紫
};

const PERIOD_LABELS: Record<Period, string> = { day: '日K', week: '周K', month: '月K' };
const MA_PERIODS = [5, 10, 20, 60];

export default function PriceTrendChart({ data, stockName }: PriceTrendChartProps) {
  const [period, setPeriod] = useState<Period>('day');
  const [maOn, setMaOn] = useState(true);
  const [macdOn, setMacdOn] = useState(false);
  const [activeMas, setActiveMas] = useState<number[]>([5, 10, 20, 60]);

  const candles = useMemo<Candle[]>(
    () => aggregateCandles(data as Candle[], period),
    [data, period],
  );
  const isSimulated = useMemo(
    () => candles.length > 0 && candles.every((c) => c.isSimulated),
    [candles],
  );

  const option = useMemo(() => {
    const dates = candles.map((c) => c.date);
    // 蜡烛数据：ECharts 要求 [open, close, low, high]
    const kline = candles.map((c) => [c.open, c.close, c.low, c.high]);
    const closes = candles.map((c) => c.close);
    const volumes = candles.map((c, i) => ({
      value: c.volume,
      itemStyle: { color: c.close >= c.open ? UP : DOWN },
      _i: i,
    }));

    // 均线
    const maSeries = maOn
      ? activeMas.map((n) => {
          const ma = computeMA(closes, n);
          return {
            name: `MA${n}`,
            type: 'line' as const,
            data: ma,
            smooth: true,
            showSymbol: false,
            lineStyle: { width: 1.2, color: MA_COLORS[n] },
            itemStyle: { color: MA_COLORS[n] },
            z: 3,
          };
        })
      : [];

    // MACD
    const macd = computeMACD(closes);
    const macdBars = macd.map((m) => ({
      value: m.macd,
      itemStyle: { color: m.macd >= 0 ? UP : DOWN },
    }));

    // 布局：根据是否显示 MACD 调整各网格高度占比
    const priceTop = macdOn ? '6%' : '8%';
    const priceH = macdOn ? '46%' : '56%';
    const volTop = macdOn ? '70%' : '68%';
    const volH = macdOn ? '14%' : '18%';

    const axisCommon = {
      axisLine: { lineStyle: { color: '#2a2a2a' } },
      axisLabel: { color: '#a0a0a0', fontSize: 10 },
      splitLine: { show: false },
    };

    const tooltip = {
      trigger: 'axis' as const,
      axisPointer: { type: 'cross' as const, link: [{ xAxisIndex: 'all' }] },
      backgroundColor: 'rgba(20,20,20,0.92)',
      borderColor: '#333',
      textStyle: { color: '#e6e6e6', fontSize: 12 },
      formatter: (params: unknown) => {
        const arr = params as {
          seriesType: string;
          dataIndex: number;
          axisValue: string;
        }[];
        if (!arr.length) return '';
        const idx = arr[0].dataIndex;
        const c = candles[idx];
        if (!c) return '';
        const chg = idx > 0 ? c.close - candles[idx - 1].close : 0;
        const chgPct = idx > 0 && candles[idx - 1].close ? (chg / candles[idx - 1].close) * 100 : 0;
        const color = c.close >= c.open ? UP : DOWN;
        const sign = chg >= 0 ? '+' : '';
        const rows = [
          `<b>${c.date}</b>`,
          `开 ${c.open.toFixed(2)}　收 <span style="color:${color}">${c.close.toFixed(2)}</span>`,
          `高 ${c.high.toFixed(2)}　低 ${c.low.toFixed(2)}`,
          `涨跌 <span style="color:${color}">${sign}${chg.toFixed(2)} (${sign}${chgPct.toFixed(2)}%)</span>`,
          `量 ${(c.volume / 10000).toFixed(2)} 万手`,
        ];
        if (maOn) {
          for (const n of activeMas) {
            const v = computeMA(closes, n)[idx];
            if (v != null) rows.push(`MA${n} ${v.toFixed(2)}`);
          }
        }
        return rows.join('<br/>');
      },
    };

    const gridPrice = { left: 56, right: 16, top: priceTop, height: priceH };
    const gridVol = { left: 56, right: 16, top: volTop, height: volH };
    const grids = [gridPrice, gridVol];
    const xAxes = [
      { type: 'category' as const, data: dates, ...axisCommon, gridIndex: 0, boundaryGap: true, axisLabel: { ...axisCommon.axisLabel, show: false } },
      { type: 'category' as const, data: dates, ...axisCommon, gridIndex: 1, boundaryGap: true },
    ];
    const yAxes = [
      { scale: true, gridIndex: 0, ...axisCommon, splitLine: { lineStyle: { color: '#1f1f1f', type: 'dashed' as const } } },
      { gridIndex: 1, ...axisCommon, splitNumber: 2 },
    ];
    const series: unknown[] = [
      {
        name: 'K线',
        type: 'candlestick',
        data: kline,
        gridIndex: 0,
        itemStyle: {
          color: UP,
          color0: DOWN,
          borderColor: UP,
          borderColor0: DOWN,
        },
        z: 2,
      },
      {
        name: '成交量',
        type: 'bar',
        data: volumes,
        gridIndex: 1,
        xAxisIndex: 1,
        yAxisIndex: 1,
        barWidth: '60%',
      },
      ...maSeries.map((s) => ({ ...s, gridIndex: 0, xAxisIndex: 0, yAxisIndex: 0 })),
    ];

    if (macdOn) {
      const macdTop = '56%';
      const macdH = '12%';
      grids.push({ left: 56, right: 16, top: macdTop, height: macdH });
      xAxes.push({ type: 'category' as const, data: dates, ...axisCommon, gridIndex: 2, boundaryGap: true, axisLabel: { ...axisCommon.axisLabel, show: false } });
      yAxes.push({ gridIndex: 2, ...axisCommon, splitNumber: 2 });
      series.push({
        name: 'DIF',
        type: 'line',
        data: macd.map((m) => m.dif),
        gridIndex: 2,
        xAxisIndex: 2,
        yAxisIndex: 2,
        showSymbol: false,
        lineStyle: { width: 1, color: '#f5c542' },
        z: 4,
      });
      series.push({
        name: 'DEA',
        type: 'line',
        data: macd.map((m) => m.dea),
        gridIndex: 2,
        xAxisIndex: 2,
        yAxisIndex: 2,
        showSymbol: false,
        lineStyle: { width: 1, color: '#36cfff' },
        z: 4,
      });
      series.push({
        name: 'MACD',
        type: 'bar',
        data: macdBars,
        gridIndex: 2,
        xAxisIndex: 2,
        yAxisIndex: 2,
        barWidth: '60%',
      });
    }

    return {
      backgroundColor: 'transparent',
      animation: true,
      animationDuration: 600,
      tooltip,
      legend: {
        data: ['K线', ...(maOn ? activeMas.map((n) => `MA${n}`) : []), ...(macdOn ? ['DIF', 'DEA', 'MACD'] : [])],
        textStyle: { color: '#a0a0a0', fontSize: 11 },
        top: 0,
        selectedMode: false,
      },
      axisPointer: { link: [{ xAxisIndex: 'all' }] },
      grid: grids,
      xAxis: xAxes,
      yAxis: yAxes,
      dataZoom: [
        { type: 'inside', xAxisIndex: xAxes.map((_, i) => i), start: Math.max(0, 100 - (200 / Math.max(dates.length, 1)) * 100 / 1), end: 100 },
        {
          type: 'slider',
          xAxisIndex: xAxes.map((_, i) => i),
          bottom: macdOn ? '1%' : '1%',
          height: 16,
          start: Math.max(0, 100 - Math.min(100, (250 / Math.max(dates.length, 1)) * 100)),
          end: 100,
          borderColor: '#333',
          fillerColor: 'rgba(45,212,191,0.12)',
          handleStyle: { color: '#2dd4bf' },
          textStyle: { color: '#a0a0a0', fontSize: 10 },
        },
      ],
      series,
    };
  }, [candles, maOn, activeMas, macdOn]);

  if (!data || data.length === 0) return null;

  const toggleMa = (n: number) => {
    setActiveMas((prev) =>
      prev.includes(n) ? prev.filter((x) => x !== n) : [...prev, n].sort((a, b) => a - b),
    );
  };

  return (
    <div className="trend-chart">
      <div className="trend-chart-head">
        <h4>
          行情走势
          {stockName ? ` · ${stockName}` : ''}
          {isSimulated && <span className="trend-badge">模拟数据</span>}
        </h4>
        <div className="trend-controls">
          <div className="seg">
            {(Object.keys(PERIOD_LABELS) as Period[]).map((p) => (
              <button
                key={p}
                className={`seg-btn ${period === p ? 'active' : ''}`}
                onClick={() => setPeriod(p)}
              >
                {PERIOD_LABELS[p]}
              </button>
            ))}
          </div>
          <button
            className={`chip-btn ${maOn ? 'active' : ''}`}
            onClick={() => setMaOn((v) => !v)}
          >
            均线
          </button>
          {maOn &&
            MA_PERIODS.map((n) => (
              <button
                key={n}
                className={`chip-btn ma-${n} ${activeMas.includes(n) ? 'active' : ''}`}
                onClick={() => toggleMa(n)}
              >
                MA{n}
              </button>
            ))}
          <button
            className={`chip-btn ${macdOn ? 'active' : ''}`}
            onClick={() => setMacdOn((v) => !v)}
          >
            MACD
          </button>
        </div>
      </div>
      <EChart option={option} style={{ height: macdOn ? 560 : 460 }} />
    </div>
  );
}
