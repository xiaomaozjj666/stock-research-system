import type { BacktestResult, OHLCVData, StrategyConfig } from '../quant/types.js';

/**
 * `ChatAgentDeps` / `ToolDeps` 的桩工厂。
 *
 * **为什么需要它**：`ChatAgentDeps` 里的 `runBacktest` / `parseStrategyInput`
 * 早前声明为全 `unknown` 参数 + `Promise<unknown>` 返回，生产实现只能靠
 * `as unknown as` 二次断言塞进来。那掩盖了两处真实差异：
 *  - `runBacktest` 是**同步**返回 `BacktestResult`（声明成 Promise，靠 await
 *    一个非 Promise 才碰巧正常）；
 *  - `parseStrategyInput` 收 `string | StrategyConfig`、返回 `StrategyConfig`。
 *
 * 签名收紧后 tsc 立刻逐条报出所有不符的桩——这些就是本文件要提供的。
 */

/** 回测结果桩：字段按 `BacktestResult` 补全 */
export function backtestResultStub(over: Partial<BacktestResult> = {}): BacktestResult {
  return {
    totalReturn: 10,
    annualizedReturn: 5,
    sharpeRatio: 1.2,
    maxDrawdown: 15,
    winRate: 55,
    tradeCount: 0,
    profitFactor: 1.8,
    equityCurve: [],
    trades: [],
    benchmark: [],
    ...over,
  };
}

/** 策略配置桩：字段按 `StrategyConfig` 补全 */
export function strategyConfigStub(over: Partial<StrategyConfig> = {}): StrategyConfig {
  return {
    name: 'ma_cross',
    type: 'ma_cross',
    stockCode: '600519',
    params: {},
    startDate: '2024-01-01',
    endDate: '2024-12-31',
    ...over,
  };
}

/** K 线桩：单根恒定 K 线 */
export function barsStub(n = 1): OHLCVData[] {
  return Array.from({ length: n }, (_, i) => ({
    date: `2024-01-${String(i + 1).padStart(2, '0')}`,
    open: 10,
    high: 10,
    low: 10,
    close: 10,
    volume: 1000,
  }));
}

/** 解析策略入参：字符串走默认配置，对象原样返回（与真实实现同构） */
export const parseStrategyStub = (input: string | StrategyConfig): StrategyConfig =>
  typeof input === 'string' ? strategyConfigStub({ name: input }) : input;
