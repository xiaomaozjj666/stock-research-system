/**
 * 回测绩效分析器（Performance Analyzers）
 * --------------------------------------------------------------------------
 * 借鉴 backtrader 的 Analyzer 模式：把"回测绩效统计"从引擎中解耦为可插拔、
 * 可独立测试的纯函数集合。引擎只负责逐 K 线撮合并产出权益曲线与交易记录，
 * 指标计算全部由分析器完成——新增指标（Calmar/最大回撤周期/换手率…）只需
 * 追加一个分析器，无需改动引擎。
 *
 * 所有函数保持与原 backtestEngine 内联实现逐字等价（数值完全一致），
 * 重构前后 BacktestResult 输出不变。
 */
import type { Trade } from './types.js';

/** 分析器输入：回测过程产物（权益曲线 + 交易记录） */
export interface AnalyzerContext {
  /** 归一化权益曲线（起始 100） */
  equityCurve: { date: string; value: number }[];
  /** 全部成交记录（含买入与卖出） */
  trades: Trade[];
  /** 年化交易日数 */
  tradingDaysPerYear?: number;
}

/** 分析器：命名 + 纯函数计算（可插拔/可替换/可独立测试） */
export interface PerformanceAnalyzer {
  name: string;
  compute(ctx: AnalyzerContext): number;
}

/** 单次交易成本率（佣金+滑点），用于胜率口径（与原实现一致） */
const TRANSACTION_COST_RATE = 0.001;
/** 无风险利率（中国 10 年期国债收益率），用于夏普/索提诺（与原实现一致） */
const RISK_FREE_RATE = 0.025;

/** 日收益率序列（由归一化权益曲线相邻点计算） */
function dailyReturnsOf(ctx: AnalyzerContext): number[] {
  const out: number[] = [];
  const c = ctx.equityCurve;
  for (let i = 1; i < c.length; i++) {
    out.push((c[i].value - c[i - 1].value) / c[i - 1].value);
  }
  return out;
}

export const totalReturnAnalyzer: PerformanceAnalyzer = {
  name: 'totalReturn',
  compute: (ctx) => {
    const c = ctx.equityCurve;
    if (c.length === 0) return 0;
    return ((c[c.length - 1].value - 100) / 100) * 100;
  },
};

export const annualizedReturnAnalyzer: PerformanceAnalyzer = {
  name: 'annualizedReturn',
  compute: (ctx) => {
    const total = totalReturnAnalyzer.compute(ctx);
    const years = ctx.equityCurve.length / (ctx.tradingDaysPerYear ?? 252);
    if (years <= 0) return 0;
    return (Math.pow(1 + total / 100, 1 / years) - 1) * 100;
  },
};

export const sharpeRatioAnalyzer: PerformanceAnalyzer = {
  name: 'sharpeRatio',
  compute: (ctx) => {
    const days = ctx.tradingDaysPerYear ?? 252;
    const dailyRiskFree = RISK_FREE_RATE / days;
    const returns = dailyReturnsOf(ctx);
    if (returns.length === 0) return 0;
    const avg = returns.reduce((a, b) => a + b, 0) / returns.length;
    const excess = avg - dailyRiskFree;
    const std = Math.sqrt(returns.reduce((s, r) => s + (r - avg) ** 2, 0) / returns.length);
    return std > 0 ? (excess / std) * Math.sqrt(days) : 0;
  },
};

export const sortinoRatioAnalyzer: PerformanceAnalyzer = {
  name: 'sortinoRatio',
  compute: (ctx) => {
    const days = ctx.tradingDaysPerYear ?? 252;
    const dailyRiskFree = RISK_FREE_RATE / days;
    const returns = dailyReturnsOf(ctx);
    if (returns.length === 0) return 0;
    const avg = returns.reduce((a, b) => a + b, 0) / returns.length;
    const excess = avg - dailyRiskFree;
    const downside = returns.map((r) => r - dailyRiskFree).filter((r) => r < 0);
    const downsideDev =
      downside.length > 0
        ? Math.sqrt(downside.reduce((s, r) => s + r * r, 0) / downside.length)
        : 0;
    return downsideDev > 0 ? (excess / downsideDev) * Math.sqrt(days) : 0;
  },
};

export const maxDrawdownAnalyzer: PerformanceAnalyzer = {
  name: 'maxDrawdown',
  compute: (ctx) => {
    let maxDrawdown = 0;
    let peak = ctx.equityCurve[0]?.value ?? 100;
    for (const point of ctx.equityCurve) {
      if (point.value > peak) peak = point.value;
      const drawdown = ((peak - point.value) / peak) * 100;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }
    return maxDrawdown;
  },
};

export const winRateAnalyzer: PerformanceAnalyzer = {
  name: 'winRate',
  compute: (ctx) => {
    const sellTrades = ctx.trades.filter((t) => t.type === 'sell');
    const buyTrades = ctx.trades.filter((t) => t.type === 'buy');
    let wins = 0;
    for (let i = 0; i < Math.min(buyTrades.length, sellTrades.length); i++) {
      const netReturn =
        sellTrades[i].price * (1 - TRANSACTION_COST_RATE) -
        buyTrades[i].price * (1 + TRANSACTION_COST_RATE);
      if (netReturn > 0) wins++;
    }
    return sellTrades.length > 0 ? (wins / sellTrades.length) * 100 : 0;
  },
};

export const profitFactorAnalyzer: PerformanceAnalyzer = {
  name: 'profitFactor',
  compute: (ctx) => {
    const sellTrades = ctx.trades.filter((t) => t.type === 'sell');
    const buyTrades = ctx.trades.filter((t) => t.type === 'buy');
    let totalProfit = 0;
    let totalLoss = 0;
    for (let i = 0; i < sellTrades.length; i++) {
      const buy = buyTrades[i];
      if (!buy) continue;
      const diff = (sellTrades[i].price - buy.price) * sellTrades[i].shares;
      if (diff > 0) totalProfit += diff;
      else totalLoss += -diff;
    }
    return totalLoss > 0 ? totalProfit / totalLoss : totalProfit > 0 ? 99 : 0;
  },
};

export const tradeCountAnalyzer: PerformanceAnalyzer = {
  name: 'tradeCount',
  compute: (ctx) => ctx.trades.length,
};

/** 默认分析器集合（与原 backtestEngine 输出字段一一对应） */
export const defaultAnalyzers: PerformanceAnalyzer[] = [
  totalReturnAnalyzer,
  annualizedReturnAnalyzer,
  sharpeRatioAnalyzer,
  sortinoRatioAnalyzer,
  maxDrawdownAnalyzer,
  winRateAnalyzer,
  profitFactorAnalyzer,
  tradeCountAnalyzer,
];

/**
 * 组装绩效指标：依次执行分析器，结果按 name 汇总（保留默认集合的原始顺序）。
 * 可传入自定义分析器集合扩展（如新增 Calmar、最大回撤周期、年化换手率）。
 */
export function computePerformance(
  ctx: AnalyzerContext,
  analyzers: PerformanceAnalyzer[] = defaultAnalyzers,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const a of analyzers) {
    out[a.name] = a.compute(ctx);
  }
  return out;
}
