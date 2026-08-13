import { describe, it, expect } from 'vitest';
import { runBacktest } from '../backtestEngine.js';
import type { OHLCVData, StrategyConfig } from '../types.js';

/** 构造前段走平、后段上行行情，使均线交叉策略在区间内产生金叉买入 */
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

function maConfig(polarity?: number): StrategyConfig {
  return {
    name: '均线交叉',
    type: 'ma_cross',
    stockCode: '600519',
    params: { shortPeriod: 5, longPeriod: 20 },
    startDate: ohlcv[0].date,
    endDate: ohlcv[ohlcv.length - 1].date,
    newsOverlay: polarity === undefined ? undefined : { polarity },
  };
}

describe('runBacktest 新闻情绪叠加层', () => {
  it('不含新闻（baseline）产生正收益并记录交易', () => {
    const r = runBacktest(ohlcv, maConfig());
    expect(r.newsAware).toBe(false);
    expect(r.tradeCount).toBeGreaterThan(0);
    expect(r.totalReturn).toBeGreaterThan(0);
  });

  it('全面利好新闻(polarity=1) → 满仓，与 baseline 一致', () => {
    const base = runBacktest(ohlcv, maConfig());
    const bull = runBacktest(ohlcv, maConfig(1));
    expect(bull.newsAware).toBe(true);
    expect(bull.newsPosture).toBeCloseTo(1, 6);
    expect(bull.totalReturn).toBeCloseTo(base.totalReturn, 6);
  });

  it('全面利空新闻(polarity=-1) → 姿态0，不建仓，收益≈0', () => {
    const bear = runBacktest(ohlcv, maConfig(-1));
    expect(bear.newsAware).toBe(true);
    expect(bear.newsPosture).toBeCloseTo(0, 6);
    expect(bear.tradeCount).toBe(0);
    expect(bear.totalReturn).toBeCloseTo(0, 6);
  });

  it('中性新闻(polarity=0) → 半仓，收益介于 0 与 baseline 之间', () => {
    const base = runBacktest(ohlcv, maConfig());
    const neutral = runBacktest(ohlcv, maConfig(0));
    expect(neutral.newsPosture).toBeCloseTo(0.5, 6);
    // 半仓买入：交易次数与 baseline 相同（同样触发买入信号），但仓位更小
    expect(neutral.tradeCount).toBe(base.tradeCount);
    expect(neutral.totalReturn).toBeLessThan(base.totalReturn);
    expect(neutral.totalReturn).toBeGreaterThan(0);
  });
});
