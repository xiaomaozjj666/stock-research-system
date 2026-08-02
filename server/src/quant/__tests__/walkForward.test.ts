import { describe, it, expect } from 'vitest';
import { rollingWindows, walkForwardBacktest } from '../walkForward.js';
import type { OHLCVData, StrategyConfig, BacktestResult } from '../types.js';

const ohlcv: OHLCVData[] = Array.from({ length: 60 }, (_, i) => ({
  date: `2024-${String(Math.floor(i / 30) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
  open: 10 + i,
  close: 11 + i,
  high: 12 + i,
  low: 9 + i,
  volume: 1000,
}));

const baseStrategy: StrategyConfig = {
  name: '均线交叉',
  type: 'ma_cross',
  stockCode: '600519',
  params: { fast: 5, slow: 20 },
  startDate: '2024-01-01',
  endDate: '2024-12-31',
};

function result(sharpe: number, totalReturn = sharpe * 10, maxDrawdown = -5): BacktestResult {
  return {
    totalReturn,
    annualizedReturn: totalReturn,
    sharpeRatio: sharpe,
    maxDrawdown,
    winRate: 55,
    tradeCount: 3,
    profitFactor: 1.5,
    equityCurve: [],
    trades: [],
    benchmark: [],
  };
}

describe('rollingWindows', () => {
  it('生成不重叠滚动窗口（step = testSize）', () => {
    const w = rollingWindows(60, 30, 15, 15);
    expect(w).toHaveLength(2);
    expect(w[0].train).toEqual([0, 29]);
    expect(w[0].test).toEqual([30, 44]);
    expect(w[1].train).toEqual([15, 44]);
    expect(w[1].test).toEqual([45, 59]);
  });

  it('参数非法或数据不足返回空', () => {
    expect(rollingWindows(60, 30, 15, 0)).toEqual([]);
    expect(rollingWindows(10, 30, 15, 15)).toEqual([]);
  });
});

describe('walkForwardBacktest', () => {
  it('样本外稳定：oosRatio 接近 1 → stable=true', () => {
    // 训练与测试都给出相近夏普
    const report = walkForwardBacktest(
      () => result(1.4),
      ohlcv,
      baseStrategy,
      { trainSize: 30, testSize: 15, step: 15 },
    );
    expect(report.insufficient).toBe(false);
    expect(report.folds).toHaveLength(2);
    expect(report.avgTrainSharpe).toBeCloseTo(1.4);
    expect(report.avgTestSharpe).toBeCloseTo(1.4);
    expect(report.oosRatio).toBeCloseTo(1);
    expect(report.stable).toBe(true);
  });

  it('样本外崩塌（过拟合信号）：oosRatio 远低于阈值 → stable=false', () => {
    let call = 0;
    const report = walkForwardBacktest(
      () => {
        // 第一个调用是 train，第二个是 test；按折交替
        const isTest = call % 2 === 1;
        call++;
        return result(isTest ? 0.1 : 1.5);
      },
      ohlcv,
      baseStrategy,
      { trainSize: 30, testSize: 15, step: 15 },
    );
    expect(report.avgTrainSharpe).toBeCloseTo(1.5);
    expect(report.avgTestSharpe).toBeCloseTo(0.1);
    expect(report.oosRatio).toBeCloseTo(0.1 / 1.5, 5);
    expect(report.stable).toBe(false);
  });

  it('数据不足以构成一个完整窗口 → insufficient=true，无折', () => {
    const short = ohlcv.slice(0, 10);
    const report = walkForwardBacktest(
      () => result(1),
      short,
      baseStrategy,
      { trainSize: 30, testSize: 15, step: 15 },
    );
    expect(report.insufficient).toBe(true);
    expect(report.folds).toHaveLength(0);
    expect(report.stable).toBe(false);
  });

  it('窗口策略的起止日期对齐到切片数据', () => {
    const report = walkForwardBacktest(
      () => result(1),
      ohlcv,
      baseStrategy,
      { trainSize: 30, testSize: 15, step: 15 },
    );
    const f0 = report.folds[0];
    expect(f0.train.start).toBe(ohlcv[0].date);
    expect(f0.train.end).toBe(ohlcv[29].date);
    expect(f0.test.start).toBe(ohlcv[30].date);
    expect(f0.test.end).toBe(ohlcv[44].date);
  });
});
