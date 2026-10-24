import { describe, expect, it } from 'vitest';
import {
  computePerformance,
  defaultAnalyzers,
  maxDrawdownAnalyzer,
  totalReturnAnalyzer,
  winRateAnalyzer,
  type AnalyzerContext,
  type PerformanceAnalyzer,
} from '../analyzers.js';
import { runBacktest } from '../backtestEngine.js';
import type { OHLCVData, StrategyConfig } from '../types.js';

function uptrendSeries(n = 80, flat = 25, low = 100, high = 220): OHLCVData[] {
  const out: OHLCVData[] = [];
  const base = new Date('2025-01-01').getTime();
  for (let i = 0; i < n; i++) {
    const price = i < flat ? low : low + ((high - low) * (i - flat)) / (n - 1 - flat);
    const d = new Date(base + i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    out.push({
      date: d,
      open: price,
      close: Math.round(price * 100) / 100,
      high: price + 1,
      low: price - 1,
      volume: 1_000_000,
    });
  }
  return out;
}

const ohlcv = uptrendSeries();

function maConfig(): StrategyConfig {
  return {
    name: '均线交叉',
    type: 'ma_cross',
    stockCode: '600519',
    params: { shortPeriod: 5, longPeriod: 20 },
    startDate: ohlcv[0].date,
    endDate: ohlcv[ohlcv.length - 1].date,
  };
}

describe('回测绩效分析器（backtrader Analyzer 模式）', () => {
  it('引擎输出与分析器独立计算完全一致（M6 后：分析层用全精度权益序列）', () => {
    const r = runBacktest(ohlcv, maConfig());
    // 复算引擎同款全精度权益序列（M6：差分算收益不受预 round 误差影响）：
    // uptrend 行情一路上涨只触发一次金叉买入、无死叉卖出，故买入 bar 之后
    // equity = cash + shares × close，cash 在买入后固定（默认成本模型：
    // fee = gross × 0.0003，minCost=0、无冲击）。
    const buy = r.trades.find((t) => t.type === 'buy')!;
    expect(buy).toBeDefined();
    const buyIdx = ohlcv.findIndex((b) => b.date === buy.date);
    expect(buyIdx).toBeGreaterThan(0);
    const fillPrice = ohlcv[buyIdx].open * 1.001; // 引擎口径：open × (1+滑点)
    const cashAfter = 1_000_000 - buy.shares * fillPrice * 1.0003;
    const rawCurve = ohlcv.map((b, i) => ({
      date: b.date,
      value: i < buyIdx ? 100 : ((cashAfter + buy.shares * b.close) / 1_000_000) * 100,
    }));
    const stats = computePerformance({
      equityCurve: rawCurve,
      trades: r.trades,
      costRate: 0.0003, // 引擎口径：默认模型双边费率均值 (0.0003+0.0003)/2
    } satisfies AnalyzerContext);
    // 引擎对 analyzer 原始输出做 2 位小数 round，此处按同口径比较
    const round = (v: number) => Math.round(v * 100) / 100;

    expect(round(stats.totalReturn)).toBe(r.totalReturn);
    expect(round(stats.annualizedReturn)).toBe(r.annualizedReturn);
    expect(round(stats.sharpeRatio)).toBe(r.sharpeRatio);
    expect(round(stats.sortinoRatio)).toBe(r.sortinoRatio);
    expect(round(stats.maxDrawdown)).toBe(r.maxDrawdown);
    expect(round(stats.winRate)).toBe(r.winRate);
    expect(round(stats.profitFactor)).toBe(r.profitFactor);
    expect(stats.tradeCount).toBe(r.tradeCount);
  });

  it('默认分析器集合覆盖全部输出指标', () => {
    expect(defaultAnalyzers.map((a) => a.name)).toEqual([
      'totalReturn',
      'annualizedReturn',
      'sharpeRatio',
      'sortinoRatio',
      'maxDrawdown',
      'winRate',
      'profitFactor',
      'tradeCount',
    ]);
  });

  it('可插拔：追加自定义分析器无需改动引擎', () => {
    // Calmar = 年化收益 / |最大回撤|（自定义指标示例）
    const calmarAnalyzer: PerformanceAnalyzer = {
      name: 'calmarRatio',
      compute: (ctx) => {
        const ann = defaultAnalyzers.find((a) => a.name === 'annualizedReturn')!.compute(ctx);
        const mdd = maxDrawdownAnalyzer.compute(ctx);
        return mdd > 0 ? ann / mdd : 0;
      },
    };
    const r = runBacktest(ohlcv, maConfig());
    const stats = computePerformance({ equityCurve: r.equityCurve, trades: r.trades }, [
      ...defaultAnalyzers,
      calmarAnalyzer,
    ]);
    expect(stats.calmarRatio).toBeDefined();
    expect(stats.calmarRatio).toBeGreaterThan(0);
    // 引擎自身输出不受影响
    expect(r).not.toHaveProperty('calmarRatio');
  });

  it('空权益曲线安全返回 0（不抛错）', () => {
    const stats = computePerformance({ equityCurve: [], trades: [] });
    expect(stats.totalReturn).toBe(0);
    expect(stats.tradeCount).toBe(0);
    expect(stats.maxDrawdown).toBe(0);
  });

  it('总收益分析器按归一化起点 100 计算', () => {
    const ctx: AnalyzerContext = {
      equityCurve: [
        { date: 'd1', value: 100 },
        { date: 'd2', value: 120 },
        { date: 'd3', value: 90 },
      ],
      trades: [],
    };
    expect(totalReturnAnalyzer.compute(ctx)).toBeCloseTo(-10, 6);
    expect(winRateAnalyzer.compute(ctx)).toBe(0);
  });
});
