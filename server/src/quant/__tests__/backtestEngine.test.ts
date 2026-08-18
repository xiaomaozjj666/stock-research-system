import { describe, it, expect } from 'vitest';
import { runBacktest } from '../backtestEngine.js';
import { A_SHARE_COST_MODEL, makeCostModel, marketImpactCost } from '../costModel.js';
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

describe('runBacktest T+1 信号延迟成交（backtrader Market / qlib shift=1 语义）', () => {
  /** 简单 SMA（与引擎 maAt 同口径） */
  function smaAt(data: OHLCVData[], idx: number, period: number): number {
    if (idx < period - 1) return NaN;
    let s = 0;
    for (let k = idx - period + 1; k <= idx; k++) s += data[k].close;
    return s / period;
  }

  /** 找到首个金叉信号 bar 下标（MA5 上穿 MA20） */
  function firstGoldenCross(data: OHLCVData[]): number {
    for (let i = 20; i < data.length; i++) {
      const prevShort = smaAt(data, i - 1, 5);
      const prevLong = smaAt(data, i - 1, 20);
      const short = smaAt(data, i, 5);
      const long = smaAt(data, i, 20);
      if (prevShort <= prevLong && short > long) return i;
    }
    return -1;
  }

  it('买入成交于信号生成次一 bar（开盘价 × (1+滑点)），而非信号当日', () => {
    const r = runBacktest(ohlcv, maConfig());
    const buy = r.trades.find((t) => t.type === 'buy')!;
    expect(buy).toBeTruthy();
    const sigIdx = firstGoldenCross(ohlcv);
    expect(sigIdx).toBeGreaterThan(0);
    // 成交日 = 信号日 + 1
    expect(buy.date).toBe(ohlcv[sigIdx + 1].date);
    // 成交价 = 次一 bar 开盘价 × (1+滑点 0.001)，round 2 位
    expect(buy.price).toBeCloseTo(ohlcv[sigIdx + 1].open * 1.001, 2);
  });

  it('卖出同样延迟：死叉信号次一 bar 开盘价成交', () => {
    const osc2 = oscillatingSeries();
    const r = runBacktest(osc2, maConfig());
    const sells = r.trades.filter((t) => t.type === 'sell');
    expect(sells.length).toBeGreaterThan(0);
    // 找到首个死叉信号 bar（MA5 下穿 MA20）
    let sigIdx = -1;
    for (let i = 20; i < osc2.length; i++) {
      const prevShort = smaAt(osc2, i - 1, 5);
      const prevLong = smaAt(osc2, i - 1, 20);
      const short = smaAt(osc2, i, 5);
      const long = smaAt(osc2, i, 20);
      if (prevShort >= prevLong && short < long) {
        sigIdx = i;
        break;
      }
    }
    expect(sigIdx).toBeGreaterThan(0);
    expect(sells[0].date).toBe(osc2[sigIdx + 1].date);
    expect(sells[0].price).toBeCloseTo(osc2[sigIdx + 1].open * 0.999, 2);
  });

  it('数据末 bar 生成的信号无法成交（无下一 bar，与真实世界一致丢弃）', () => {
    // 前 29 天平盘（MA5=MA20=100），最后一天跳涨 → 金叉只在末 bar，无法成交
    const flatUp: OHLCVData[] = [];
    const base = new Date('2025-01-01').getTime();
    for (let i = 0; i < 30; i++) {
      const close = i === 29 ? 120 : 100;
      const d = new Date(base + i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      flatUp.push({
        date: d,
        open: i === 29 ? 110 : 100,
        close,
        high: close,
        low: close - 1,
        volume: 1_000_000,
      });
    }
    expect(firstGoldenCross(flatUp)).toBe(29); // 金叉确实只在末 bar
    const r = runBacktest(flatUp, maConfig());
    expect(r.tradeCount).toBe(0);
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
    // 每笔费用 = max(成交额 × closeRate, minCost) + 二次方市场冲击（impactCost × (成交额/成交量)²）
    // （交易记录 price 保留 2 位小数，费用按未舍入价计算，容差 ±0.05）
    for (const s of sells) {
      const gross = s.shares * s.price;
      const fee = Math.max(gross * A_SHARE_COST_MODEL.closeRate, A_SHARE_COST_MODEL.minCost);
      const impact = marketImpactCost(A_SHARE_COST_MODEL, gross, 1_000_000);
      const expected = Math.round((fee + impact) * 100) / 100;
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

  it('市场冲击经引擎路径生效：成交占比高时费用更高（qlib 二次方冲击）', () => {
    // 低成交量行情（2 万）：成交额 ~100 万 → 成交占比 ~50 → 冲击 = 0.1 × 50² = 250 元/笔，显著可见
    const thin = osc.map((b) => ({ ...b, volume: 20_000 }));
    const withImpact = runBacktest(
      thin,
      maConfig(),
      makeCostModel({ impactCost: 0.1, minCost: 0, slippage: 0.001 }),
    );
    const withoutImpact = runBacktest(thin, maConfig());
    expect(withImpact.tradeCount).toBe(withoutImpact.tradeCount);
    expect(withImpact.totalReturn).toBeLessThan(withoutImpact.totalReturn);
    // 冲击成本逐笔计入 commission 字段
    for (let i = 0; i < withImpact.trades.length; i++) {
      expect(withImpact.trades[i].commission).toBeGreaterThan(withoutImpact.trades[i].commission);
    }
  });
});
