import type { OHLCVData, StrategyConfig, BacktestResult } from './types.js';

/** 一个滚动窗口的索引区间（含端点） */
export interface WindowRange {
  train: [number, number];
  test: [number, number];
}

/**
 * 生成滚动（rolling）训练/测试窗口索引。
 *  - 每个窗口：train = [start, start+trainSize-1]，test = [start+trainSize, ...+testSize-1]。
 *  - 每次前移 step，直到 test 区间超出序列长度。
 * 纯函数，便于单测。序列过短无法容纳一个完整窗口时返回 []。
 */
export function rollingWindows(
  n: number,
  trainSize: number,
  testSize: number,
  step: number,
): WindowRange[] {
  if (n <= 0 || trainSize <= 0 || testSize <= 0 || step <= 0) return [];
  const out: WindowRange[] = [];
  let start = 0;
  while (start + trainSize + testSize <= n) {
    out.push({
      train: [start, start + trainSize - 1],
      test: [start + trainSize, start + trainSize + testSize - 1],
    });
    start += step;
  }
  return out;
}

export interface WalkForwardFold {
  index: number;
  train: { start: string; end: string; sharpeRatio: number; totalReturn: number; maxDrawdown: number };
  test: { start: string; end: string; sharpeRatio: number; totalReturn: number; maxDrawdown: number };
}

export interface WalkForwardReport {
  /** 各折的样本内(train) / 样本外(test) 表现 */
  folds: WalkForwardFold[];
  /** 平均样本内夏普 */
  avgTrainSharpe: number;
  /** 平均样本外夏普 */
  avgTestSharpe: number;
  /** 样本外稳定性 = avgTestSharpe / avgTrainSharpe（≤0 或除零时记 0） */
  oosRatio: number;
  /** 样本外夏普相对样本内不低于阈值（默认 0.5）即视为稳健 */
  stable: boolean;
  /** 数据不足以构成一个完整窗口 */
  insufficient: boolean;
}

export interface WalkForwardOptions {
  trainSize?: number;
  testSize?: number;
  step?: number;
  /** oosRatio 稳健阈值，默认 0.5 */
  oosRatioThreshold?: number;
}

/** 取回测结果的关键指标（缺省安全值） */
function metricsOf(r: BacktestResult) {
  return {
    sharpeRatio: isFinite(r.sharpeRatio) ? r.sharpeRatio : 0,
    totalReturn: isFinite(r.totalReturn) ? r.totalReturn : 0,
    maxDrawdown: isFinite(r.maxDrawdown) ? r.maxDrawdown : 0,
  };
}

/**
 * Walk-forward（滚动样本外）稳健性回测。
 * 将整段行情切成多个 train/test 窗口，对每个窗口分别回测，
 * 用「样本外夏普 / 样本内夏普」衡量策略是否过度拟合：
 *   - oosRatio 越接近 1，策略越稳健；远低于 1 说明样本内漂亮、样本外崩塌（过拟合信号）。
 * runBacktest 由调用方注入，便于离线/测试时用桩函数替换。
 */
export function walkForwardBacktest(
  runBacktest: (data: OHLCVData[], strategy: StrategyConfig) => BacktestResult,
  ohlcv: OHLCVData[],
  strategy: StrategyConfig,
  opts: WalkForwardOptions = {},
): WalkForwardReport {
  const n = ohlcv.length;
  const trainSize = opts.trainSize ?? Math.max(20, Math.floor(n * 0.6));
  const testSize = opts.testSize ?? Math.max(10, Math.floor(n * 0.2));
  const step = opts.step ?? testSize;
  const threshold = opts.oosRatioThreshold ?? 0.5;

  const windows = rollingWindows(n, trainSize, testSize, step);
  if (windows.length === 0) {
    return {
      folds: [],
      avgTrainSharpe: 0,
      avgTestSharpe: 0,
      oosRatio: 0,
      stable: false,
      insufficient: true,
    };
  }

  const folds: WalkForwardFold[] = windows.map((w, i) => {
    const trainData = ohlcv.slice(w.train[0], w.train[1] + 1);
    const testData = ohlcv.slice(w.test[0], w.test[1] + 1);
    const trainStrat: StrategyConfig = {
      ...strategy,
      startDate: trainData[0]?.date ?? strategy.startDate,
      endDate: trainData[trainData.length - 1]?.date ?? strategy.endDate,
    };
    const testStrat: StrategyConfig = {
      ...strategy,
      startDate: testData[0]?.date ?? strategy.startDate,
      endDate: testData[testData.length - 1]?.date ?? strategy.endDate,
    };
    const tm = metricsOf(runBacktest(trainData, trainStrat));
    const pm = metricsOf(runBacktest(testData, testStrat));
    return {
      index: i,
      train: { start: trainStrat.startDate, end: trainStrat.endDate, ...tm },
      test: { start: testStrat.startDate, end: testStrat.endDate, ...pm },
    };
  });

  const avgTrainSharpe = folds.reduce((s, f) => s + f.train.sharpeRatio, 0) / folds.length;
  const avgTestSharpe = folds.reduce((s, f) => s + f.test.sharpeRatio, 0) / folds.length;
  const oosRatio =
    isFinite(avgTrainSharpe) && avgTrainSharpe !== 0 ? avgTestSharpe / avgTrainSharpe : 0;

  return {
    folds,
    avgTrainSharpe,
    avgTestSharpe,
    oosRatio,
    stable: oosRatio >= threshold,
    insufficient: false,
  };
}
