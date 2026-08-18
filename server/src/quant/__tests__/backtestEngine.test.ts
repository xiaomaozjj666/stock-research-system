import { describe, it, expect } from 'vitest';
import { runBacktest } from '../backtestEngine.js';
import { A_SHARE_COST_MODEL, makeCostModel } from '../costModel.js';
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

/** 构造「走平 → 上涨 → 回落」行情，使均线交叉策略同时产生金叉买入与死叉卖出 */
function oscillatingSeries(n = 120, flat = 20, low = 100, peak = 200, end = 120): OHLCVData[] {
  const out: OHLCVData[] = [];
  const base = new Date('2025-01-01').getTime();
  const up = Math.floor((n - flat) / 2);
  const down = n - flat - up;
  for (let i = 0; i < n; i++) {
    let price: number;
    if (i < flat) {
      price = low;
    } else if (i < flat + up) {
      price = low + ((peak - low) * (i - flat)) / (up - 1);
    } else {
      price = peak - ((peak - end) * (i - flat - up)) / (down - 1);
    }
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

describe('runBacktest 可插拔成本模型', () => {
  const osc = oscillatingSeries();

  it('未传 costModel 时按 commission/slippage 构造对称模型（历史行为等价）', () => {
    // 显式传入与默认相同参数的对称模型 → 结果应与隐式路径一致
    const implicit = runBacktest(osc, maConfig());
    const explicit = runBacktest(
      osc,
      maConfig(),
      makeCostModel({ openRate: 0.0003, closeRate: 0.0003, slippage: 0.001 }),
    );
    expect(explicit.totalReturn).toBe(implicit.totalReturn);
    expect(explicit.equityCurve).toEqual(implicit.equityCurve);
  });

  it("strategy.costModel='a_share' 使用 A 股真实费率（卖出含印花税）", () => {
    const cfg = { ...maConfig(), costModel: 'a_share' as const };
    const r = runBacktest(osc, cfg);
    expect(r.tradeCount).toBeGreaterThan(0);
    // 振荡行情下应产生卖出
    const sells = r.trades.filter((t) => t.type === 'sell');
    expect(sells.length).toBeGreaterThan(0);
    // 卖出费用 = max(成交额 × closeRate, minCost)，与 A_SHARE_COST_MODEL 一致
    // （交易记录 price 保留 2 位小数，费用按未舍入价计算，容差 ±0.05）
    for (const s of sells) {
      const gross = s.shares * s.price;
      const expected =
        Math.round(
          Math.max(gross * A_SHARE_COST_MODEL.closeRate, A_SHARE_COST_MODEL.minCost) * 100,
        ) / 100;
      expect(s.commission).toBeCloseTo(expected, 1);
    }
  });

  it('A 股模型卖出成本高于对称模型（印花税单边）→ 净收益更低', () => {
    const baseline = runBacktest(osc, maConfig());
    const aShare = runBacktest(osc, { ...maConfig(), costModel: 'a_share' });
    expect(aShare.tradeCount).toBe(baseline.tradeCount);
    // 卖出多收印花税（万5/笔），买入佣金差（万2.5 vs 万3）不足以抵消
    expect(aShare.totalReturn).toBeLessThan(baseline.totalReturn);
  });

  it('注入自定义成本模型（零成本）→ 收益不低于默认模型', () => {
    const free = runBacktest(
      osc,
      maConfig(),
      makeCostModel({ openRate: 0, closeRate: 0, minCost: 0, slippage: 0 }),
    );
    const baseline = runBacktest(osc, maConfig());
    expect(free.tradeCount).toBeGreaterThan(0);
    expect(free.totalReturn).toBeGreaterThanOrEqual(baseline.totalReturn);
  });

  it('minCost 兜底经引擎路径生效：每笔费用按最低费用收取', () => {
    // 初始资金 5 万 → 成交额 ~5 万 → 比例费用（~12.5 元）< minCost=100 → 每笔费用恰为 100
    const cfg: StrategyConfig = { ...maConfig(), initialCapital: 50000 };
    const r = runBacktest(
      osc,
      cfg,
      makeCostModel({ openRate: 0.00025, closeRate: 0.00075, minCost: 100, slippage: 0.001 }),
    );
    expect(r.tradeCount).toBeGreaterThan(0);
    for (const t of r.trades) {
      expect(t.commission).toBe(100);
    }
  });
});
