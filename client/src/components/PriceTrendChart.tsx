import { useMemo, useRef, useState } from 'react';
import EChart from './EChart';
import type { ECharts } from '../lib/echarts';
import type { PricePoint } from '../types';
import {
  aggregateCandles,
  computeBOLL,
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
const MA_PERIODS = [5, 10, 20, 60];
const PERIOD_LABELS: Record<Period, string> = { day: '日K', week: '周K', month: '月K' };
const PERIODS: Period[] = ['day', 'week', 'month'];

const r2 = (n: number) => n.toFixed(2);

/* ---- 最新价标线（右侧价格轴上画一条虚线 + 价格标签，行业通用） ---- */
function lastCloseMarkLine(closes: number[]) {
  if (closes.length === 0) return undefined;
  const last = closes[closes.length - 1];
  const prev = closes.length > 1 ? closes[closes.length - 2] : last;
  const color = last >= prev ? UP : DOWN;
  return {
    silent: true,
    symbol: 'none' as const,
    lineStyle: { color, type: 'dashed' as const, width: 1, opacity: 0.85 },
    label: {
      show: true,
      position: 'end' as const,
      formatter: last.toFixed(2),
      color: '#fff',
      backgroundColor: color,
      padding: [1, 4] as [number, number],
      fontSize: 9,
      borderRadius: 2,
    },
    data: [{ yAxis: last }],
  };
}

/* ---- 悬浮提示框（吸顶十字光标联动） ---- */
function tooltipFormatter(
  params: unknown,
  candles: Candle[],
  activeMas: number[],
  maOn: boolean,
  closes: number[],
): string {
  const arr = params as { dataIndex: number }[];
  if (!arr.length) return '';
  const i = arr[0].dataIndex;
  const c = candles[i];
  if (!c) return '';
  const prev = i > 0 ? candles[i - 1] : null;
  const chg = prev ? c.close - prev.close : 0;
  const pct = prev && prev.close ? (chg / prev.close) * 100 : 0;
  const up = chg >= 0;
  const col = up ? UP : DOWN;
  const s = up ? '+' : '';
  const rows: string[] = [];
  rows.push(`<div style="margin-bottom:4px;color:#cfcfcf">${c.date}</div>`);
  rows.push(
    `开 ${r2(c.open)}　高 ${r2(c.high)}　低 ${r2(c.low)}　收 <b style="color:${col}">${r2(c.close)}</b>`,
  );
  rows.push(`涨跌 <b style="color:${col}">${s}${r2(chg)} (${s}${pct.toFixed(2)}%)</b>`);
  rows.push(`量 ${(c.volume / 10000).toFixed(2)} 万手`);
  if (maOn) {
    for (const n of activeMas) {
      const v = computeMA(closes, n)[i];
      if (v != null) rows.push(`<span style="color:${MA_COLORS[n]}">MA${n} ${v.toFixed(2)}</span>`);
    }
  }
  return rows.join('<br/>');
}

export default function PriceTrendChart({ data, stockName }: PriceTrendChartProps) {
  const [period, setPeriod] = useState<Period>('day');
  const [maOn, setMaOn] = useState(true);
  const [activeMas, setActiveMas] = useState<number[]>([5, 10, 20, 60]);
  const [bollOn, setBollOn] = useState(false);
  const [macdOn, setMacdOn] = useState(false);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const chartRef = useRef<ECharts | null>(null);

  const candles = useMemo<Candle[]>(
    () => aggregateCandles(data as Candle[], period),
    [data, period],
  );
  // 把最新 candles 存进 ref，供图表事件回调读取（避免闭包拿到旧值）
  const candlesRef = useRef(candles);
  candlesRef.current = candles;

  const isSimulated = useMemo(
    () => candles.length > 0 && candles.every((c) => c.isSimulated),
    [candles],
  );

  // 图表就绪后挂「吸顶光标」监听：悬停时把命中的 K 线索引同步到 React，
  // 驱动顶部 OHLC 实况图例实时更新（同花顺/东方财富同款交互）。
  const handleReady = (chart: ECharts) => {
    chartRef.current = chart;
    chart.on('updateAxisPointer', (p: unknown) => {
      const e = p as { axesInfo?: { value?: number | string }[] };
      const v = e.axesInfo?.[0]?.value;
      const cs = candlesRef.current;
      if (typeof v === 'number' && cs[v]) {
        setHoverIdx(v);
      } else if (typeof v === 'string') {
        const i = cs.findIndex((c) => c.date === v);
        if (i >= 0) setHoverIdx(i);
      }
    });
    chart.getZr().on('mouseout', () => setHoverIdx(null));
  };

  const option = useMemo(() => {
    if (candles.length === 0) return {};
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
      ? activeMas.map((n) => ({
          name: `MA${n}`,
          type: 'line' as const,
          data: computeMA(closes, n),
          smooth: true,
          showSymbol: false,
          lineStyle: { width: 1.2, color: MA_COLORS[n] },
          itemStyle: { color: MA_COLORS[n] },
          z: 5,
        }))
      : [];

    // 布林带
    const bollSeries: unknown[] = [];
    if (bollOn) {
      const b = computeBOLL(closes, 20, 2);
      const mk = (name: string, arr: number[], color: string, opacity: number) => ({
        name,
        type: 'line' as const,
        data: arr,
        smooth: true,
        showSymbol: false,
        lineStyle: { width: 1, color, opacity },
        itemStyle: { color },
        z: 4,
      });
      bollSeries.push(mk('BOLL上轨', b.map((x) => x.upper), '#8a8f98', 0.85));
      bollSeries.push(mk('BOLL中轨', b.map((x) => x.mid), '#c9cdd4', 0.95));
      bollSeries.push(mk('BOLL下轨', b.map((x) => x.lower), '#8a8f98', 0.85));
    }

    // MACD
    const macd = computeMACD(closes);
    const macdBars = macd.map((m) => ({
      value: m.macd,
      itemStyle: { color: m.macd >= 0 ? UP : DOWN },
    }));

    // 布局：价 / 量 / (MACD) 三宫格共享 X 轴，紧凑分隔（行业通用）
    const hasMacd = macdOn;
    const left = 8;
    const right = 64; // 右侧价格轴留白（给最新价标签足够空间，避免贴边裁切）
    let priceTop: number, priceH: number, volTop: number, volH: number, macdTop: number, macdH: number;
    if (hasMacd) {
      priceTop = 4; priceH = 44; volTop = 52; volH = 13; macdTop = 69; macdH = 13;
    } else {
      priceTop = 5; priceH = 58; volTop = 67; volH = 15; macdTop = 0; macdH = 0;
    }

    const axisCommon = {
      axisLine: { lineStyle: { color: '#2a2a2a' } },
      axisTick: { show: false },
      axisLabel: { color: '#8a8a8a', fontSize: 10 },
      splitLine: { show: false },
    };

    const gridPrice = { left, right, top: `${priceTop}%`, height: `${priceH}%` };
    const gridVol = { left, right, top: `${volTop}%`, height: `${volH}%` };
    const grids = [gridPrice, gridVol];
    const xAxes: unknown[] = [
      {
        type: 'category' as const, data: dates, gridIndex: 0, boundaryGap: true,
        ...axisCommon, axisLabel: { ...axisCommon.axisLabel, show: false },
        axisPointer: { show: true, label: { show: false } },
      },
      {
        type: 'category' as const, data: dates, gridIndex: 1, boundaryGap: true,
        ...axisCommon,
      },
    ];
    const yAxes: unknown[] = [
      {
        type: 'value' as const, scale: true, gridIndex: 0, position: 'right' as const,
        ...axisCommon,
        splitLine: { lineStyle: { color: '#1b1b1b', type: 'dashed' as const } },
        axisLabel: { ...axisCommon.axisLabel, formatter: (v: number) => v.toFixed(2) },
      },
      {
        type: 'value' as const, gridIndex: 1, position: 'right' as const,
        ...axisCommon, splitNumber: 2,
        axisLabel: { ...axisCommon.axisLabel, formatter: (v: number) => `${(v / 10000).toFixed(0)}万` },
      },
    ];
    const series: unknown[] = [
      {
        name: 'K线',
        type: 'candlestick',
        data: kline,
        gridIndex: 0,
        xAxisIndex: 0,
        yAxisIndex: 0,
        itemStyle: { color: UP, color0: DOWN, borderColor: UP, borderColor0: DOWN },
        z: 3,
        markLine: lastCloseMarkLine(closes),
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
      ...bollSeries.map((s) => ({ ...(s as object), gridIndex: 0, xAxisIndex: 0, yAxisIndex: 0 })),
    ];

    if (hasMacd) {
      grids.push({ left, right, top: `${macdTop}%`, height: `${macdH}%` });
      xAxes.push({
        type: 'category' as const, data: dates, gridIndex: 2, boundaryGap: true,
        ...axisCommon, axisLabel: { ...axisCommon.axisLabel, show: false },
        axisPointer: { show: true, label: { show: false } },
      });
      yAxes.push({
        type: 'value' as const, gridIndex: 2, position: 'right' as const,
        ...axisCommon, splitNumber: 2,
      });
      series.push(
        {
          name: 'DIF', type: 'line', data: macd.map((m) => m.dif),
          gridIndex: 2, xAxisIndex: 2, yAxisIndex: 2, showSymbol: false,
          lineStyle: { width: 1, color: '#f5c542' }, z: 6,
        },
        {
          name: 'DEA', type: 'line', data: macd.map((m) => m.dea),
          gridIndex: 2, xAxisIndex: 2, yAxisIndex: 2, showSymbol: false,
          lineStyle: { width: 1, color: '#36cfff' }, z: 6,
        },
        {
          name: 'MACD', type: 'bar', data: macdBars,
          gridIndex: 2, xAxisIndex: 2, yAxisIndex: 2, barWidth: '60%',
        },
      );
    }

    // 默认展示最近约 220（无 MACD）/ 180（有 MACD）个交易日
    const n = dates.length;
    const showCount = hasMacd ? 180 : 220;
    const startPct = Math.max(0, 100 - Math.min(100, (showCount / Math.max(n, 1)) * 100));
    const xIdx = xAxes.map((_, i) => i);

    return {
      backgroundColor: 'transparent',
      animation: true,
      animationDuration: 400,
      animationDurationUpdate: 300,
      axisPointer: {
        link: [{ xAxisIndex: 'all' }],
        label: {
          backgroundColor: '#222',
          borderColor: '#333',
          borderWidth: 1,
          color: '#e6e6e6',
          fontSize: 10,
        },
        lineStyle: { color: '#3a3a3a', width: 1, type: 'dashed' },
      },
      tooltip: {
        trigger: 'axis' as const,
        axisPointer: { type: 'cross' as const, link: [{ xAxisIndex: 'all' }] },
        backgroundColor: 'rgba(18,18,18,0.95)',
        borderColor: '#333',
        borderWidth: 1,
        padding: [8, 10],
        textStyle: { color: '#e6e6e6', fontSize: 12 },
        formatter: (params: unknown) => tooltipFormatter(params, candles, activeMas, maOn, closes),
      },
      grid: grids,
      xAxis: xAxes,
      yAxis: yAxes,
      dataZoom: [
        { type: 'inside', xAxisIndex: xIdx, start: startPct, end: 100 },
        {
          type: 'slider',
          xAxisIndex: xIdx,
          bottom: 0,
          height: 16,
          start: startPct,
          end: 100,
          borderColor: '#2a2a2a',
          fillerColor: 'rgba(76,141,255,0.12)',
          handleStyle: { color: '#4c8dff' },
          moveHandleStyle: { color: '#4c8dff' },
          dataBackground: {
            lineStyle: { color: '#3a3a3a' },
            areaStyle: { color: 'rgba(58,58,58,0.3)' },
          },
          selectedDataBackground: {
            lineStyle: { color: '#4c8dff' },
            areaStyle: { color: 'rgba(76,141,255,0.2)' },
          },
          textStyle: { color: '#8a8a8a', fontSize: 10 },
        },
      ],
      series,
    };
  }, [candles, maOn, activeMas, bollOn, macdOn]);

  if (!data || data.length === 0) return null;

  const closes = candles.map((c) => c.close);
  const idx = hoverIdx != null && candles[hoverIdx] ? hoverIdx : candles.length - 1;
  const c = candles[idx];
  const prev = idx > 0 ? candles[idx - 1] : null;
  const chg = prev ? c.close - prev.close : 0;
  const chgPct = prev && prev.close ? (chg / prev.close) * 100 : 0;
  const up = chg >= 0;

  const toggleMa = (n: number) => {
    setActiveMas((prevArr) =>
      prevArr.includes(n) ? prevArr.filter((x) => x !== n) : [...prevArr, n].sort((a, b) => a - b),
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
            {PERIODS.map((p) => (
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
            className={`chip-btn ${bollOn ? 'active' : ''}`}
            onClick={() => setBollOn((v) => !v)}
          >
            BOLL
          </button>
          <button
            className={`chip-btn ${macdOn ? 'active' : ''}`}
            onClick={() => setMacdOn((v) => !v)}
          >
            MACD
          </button>
        </div>
      </div>

      <div className="trend-plot">
        {/* 吸顶 OHLC 实况图例：鼠标悬停实时刷新，点击均线可隐藏 */}
        <div className="trend-legend">
          <span className="tl-date">{c.date}</span>
          <span className="tl-ohlc">
            <span className="tl-label">开</span> <b className="tl-val">{r2(c.open)}</b>{' '}
            <span className="tl-label">高</span> <b className="tl-val">{r2(c.high)}</b>{' '}
            <span className="tl-label">低</span> <b className="tl-val">{r2(c.low)}</b>{' '}
            <span className="tl-label">收</span>{' '}
            <b style={{ color: up ? UP : DOWN }}>{r2(c.close)}</b>
          </span>
          <span className="tl-chg" style={{ color: up ? UP : DOWN }}>
            {up ? '+' : ''}
            {r2(chg)} ({up ? '+' : ''}
            {chgPct.toFixed(2)}%)
          </span>
          {maOn &&
            activeMas.map((n) => {
              const v = computeMA(closes, n)[idx];
              return v != null ? (
                <button
                  key={n}
                  className="tl-ma"
                  style={{ color: MA_COLORS[n] }}
                  onClick={() => toggleMa(n)}
                  title="点击隐藏该均线"
                >
                  MA{n} {v.toFixed(2)}
                </button>
              ) : null;
            })}
          {bollOn &&
            (() => {
              const m = computeBOLL(closes, 20, 2)[idx]?.mid;
              return m != null && !Number.isNaN(m) ? (
                <span className="tl-boll" style={{ color: '#c9cdd4' }}>
                  BOLL {m.toFixed(2)}
                </span>
              ) : null;
            })()}
        </div>
        <EChart
          option={option}
          className={`trend-plot-chart ${macdOn ? 'trend-plot-chart-macd' : ''}`}
          onChartReady={handleReady}
        />
      </div>
    </div>
  );
}
