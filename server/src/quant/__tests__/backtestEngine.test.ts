import { describe, it, expect } from 'vitest';
import { newsOverlayPostureAt, factorOverlayPostureAt, runBacktest } from '../backtestEngine.js';
import { A_SHARE_COST_MODEL, makeCostModel, marketImpactCost } from '../costModel.js';
import type { OHLCVData, StrategyConfig, FactorOverlay } from '../types.js';

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

/** 带因子叠加层（组合 alpha → 仓位姿态）的策略配置 */
function factorConfig(overlay?: FactorOverlay): StrategyConfig {
  return { ...maConfig(), factorOverlay: overlay };
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
    // 每笔费用 = max(成交额 × closeRate, minCost) + 二次方市场冲击
    // （impactCost × 参与率² × 成交额；bar.volume=1_000_000 手 = 1e8 股，与 s.shares 同单位）
    // （交易记录 price 保留 2 位小数，费用按未舍入价计算，容差 ±0.05）
    for (const s of sells) {
      const gross = s.shares * s.price;
      const fee = Math.max(gross * A_SHARE_COST_MODEL.closeRate, A_SHARE_COST_MODEL.minCost);
      const impact = marketImpactCost(A_SHARE_COST_MODEL, gross, 100_000_000, s.shares);
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

  it('市场冲击经引擎路径生效：成交参与率高时费用更高（qlib 二次方冲击）', () => {
    // 低成交量行情（2 万手 = 2e6 股）：成交 ~1 万股 → 参与率 ~0.5% →
    // 冲击 = 0.1 × 0.005² × 100 万 ≈ 2.5 元/笔，低于默认费率但显著可测
    const thin = osc.map((b) => ({ ...b, volume: 20_000 }));
    const withImpact = runBacktest(
      thin,
      maConfig(),
      makeCostModel({ impactCost: 0.1, minCost: 0, slippage: 0.001 }),
    );
    const withoutImpact = runBacktest(thin, maConfig());
    expect(withImpact.tradeCount).toBe(withoutImpact.tradeCount);
    // 冲击金额（~2.5 元/笔）低于权益曲线 0.01% 的展示精度，用逐笔费用断言验证
    expect(withImpact.totalReturn).toBeLessThanOrEqual(withoutImpact.totalReturn);
    // 冲击成本逐笔计入 commission 字段
    for (let i = 0; i < withImpact.trades.length; i++) {
      expect(withImpact.trades[i].commission).toBeGreaterThan(withoutImpact.trades[i].commission);
    }
  });

  it('停牌 bar（volume=0）不撮合，信号顺延到恢复交易后成交', () => {
    const suspended = oscillatingSeries().map((b, i) => ({
      ...b,
      volume: i === 5 || i === 6 ? 0 : b.volume, // 连续两根停牌
    }));
    const normal = runBacktest(oscillatingSeries(), maConfig());
    const r = runBacktest(suspended, maConfig());
    // 停牌日的 open 上没有成交记录
    const suspendedDates = new Set([suspended[5].date, suspended[6].date]);
    for (const t of r.trades) {
      expect(suspendedDates.has(t.date)).toBe(false);
    }
    // 恢复交易后信号仍会成交（顺延语义），交易数量与正常行情一致
    expect(r.tradeCount).toBe(normal.tradeCount);
  });
});

// ============================================================
// 新闻情绪叠加：严格时序（newsOverlay.items 分段加权）
// ============================================================

describe('newsOverlayPostureAt 新闻姿态（严格时序）', () => {
  it('无叠加层时恒为 1（与基线一致）', () => {
    expect(newsOverlayPostureAt(undefined, '2025-06-01')).toBe(1);
  });

  it('旧口径：聚合极性常数，自 since 起生效，此前为 1', () => {
    const overlay = { polarity: 0.6, since: '2025-06-01' };
    expect(newsOverlayPostureAt(overlay, '2025-05-31')).toBe(1);
    expect(newsOverlayPostureAt(overlay, '2025-06-01')).toBeCloseTo(0.8, 10);
    // 无 since 时全程常数（旧调用方兼容）
    expect(newsOverlayPostureAt({ polarity: 0.6 }, '2025-01-01')).toBeCloseTo(0.8, 10);
  });

  it('items 优先：本 bar 尚无已知新闻时为 1，已知新闻按极性给姿态', () => {
    const overlay = { polarity: 1, items: [{ publishedAt: '2025-06-01', polarity: 1 }] };
    // 新闻发布日前：无已知信息 → 与基线一致
    expect(newsOverlayPostureAt(overlay, '2025-05-31')).toBe(1);
    // 发布当日：单一极性 +1 → 满仓
    expect(newsOverlayPostureAt(overlay, '2025-06-01')).toBe(1);
  });

  it('多空混合按时效衰减加权：旧看多消息随时间淡出，新利空主导', () => {
    const overlay = {
      polarity: 0,
      items: [
        { publishedAt: '2025-06-01', polarity: 1 },
        { publishedAt: '2025-07-01', polarity: -1 },
      ],
    };
    // 第一条新闻次日：只知道看多 → 满仓
    expect(newsOverlayPostureAt(overlay, '2025-06-02')).toBe(1);
    // 一个月后：+1 已衰减（半衰期 5.8 天），-1 主导 → 姿态接近 0
    const late = newsOverlayPostureAt(overlay, '2025-07-15');
    expect(late).toBeGreaterThan(0);
    expect(late).toBeLessThan(0.1);
    // 未来新闻不参与：回到 2025-06-02 仍只看得到第一条
    expect(newsOverlayPostureAt(overlay, '2025-06-02')).toBe(1);
  });

  it('items 为空数组时退化为旧口径', () => {
    expect(newsOverlayPostureAt({ polarity: 0.6, items: [] }, '2025-01-01')).toBeCloseTo(0.8, 10);
  });
});

describe('runBacktest 新闻情绪时间线（严格时序、无前视偏差）', () => {
  const osc = oscillatingSeries();
  // 首个金叉买入约在 bar 21+（flat=20），bar 9 发布利空 → 全部建仓都被压制
  const earlyBearish: StrategyConfig = {
    ...maConfig(),
    newsOverlay: {
      polarity: -0.4,
      items: [{ publishedAt: '2025-01-10', polarity: -0.4 }],
    },
  };
  const baseline = runBacktest(osc, maConfig());
  const withNews = runBacktest(osc, earlyBearish);

  it('新闻发布后的建仓按姿态缩放：买入股数严格小于基线', () => {
    expect(withNews.tradeCount).toBe(baseline.tradeCount);
    const baseBuy = baseline.trades.find((t) => t.type === 'buy');
    const newsBuy = withNews.trades.find((t) => t.type === 'buy');
    expect(baseBuy).toBeDefined();
    expect(newsBuy).toBeDefined();
    expect(newsBuy!.shares).toBeLessThan(baseBuy!.shares);
    // 姿态 0.3 写入成交记录，便于审计
    expect(withNews.trades.some((t) => t.reason.includes('新闻姿态30%'))).toBe(true);
    expect(withNews.newsAware).toBe(true);
    expect(withNews.newsSince).toBe('2025-01-10');
  });

  it('未来发布的新闻不影响历史交易（无前视偏差）：权益曲线与基线完全一致', () => {
    // 行情窗口 2025-01-01 ~ 2025-04-30，新闻发布于窗口之外
    const futureNews: StrategyConfig = {
      ...maConfig(),
      newsOverlay: {
        polarity: -1,
        items: [{ publishedAt: '2025-06-15', polarity: -1 }],
      },
    };
    const r = runBacktest(osc, futureNews);
    expect(r.tradeCount).toBe(baseline.tradeCount);
    expect(r.equityCurve).toEqual(baseline.equityCurve);
  });

  it('旧口径（无 items）行为保持：自 since 起常数姿态', () => {
    const legacy: StrategyConfig = {
      ...maConfig(),
      newsOverlay: { polarity: -0.4, since: '2025-04-01' },
    };
    const r = runBacktest(osc, legacy);
    // 窗口内全部买入都在 since 之前 → 不受影响，与基线一致
    expect(r.equityCurve).toEqual(baseline.equityCurve);
  });
});

// ============================================================
// 组合 alpha 信号叠加层（factorOverlay）：研究信号 → 可交易 overlay
// ============================================================

describe('factorOverlayPostureAt 组合 alpha 姿态', () => {
  it('无叠加层时恒为 1（与基线一致）', () => {
    expect(factorOverlayPostureAt(undefined)).toBe(1);
  });

  it('由 alpha 推导：alpha>0 → 满仓以上、alpha<0 → 半仓以下、alpha=0 → 半仓', () => {
    expect(factorOverlayPostureAt({ direction: 'up', alpha: 0.5 })).toBeCloseTo(0.75, 10);
    expect(factorOverlayPostureAt({ direction: 'down', alpha: -0.5 })).toBeCloseTo(0.25, 10);
    expect(factorOverlayPostureAt({ direction: 'neutral', alpha: 0 })).toBeCloseTo(0.5, 10);
  });

  it('显式 posture 优先并截到 [0,1]', () => {
    expect(factorOverlayPostureAt({ direction: 'up', alpha: 0.5, posture: 0.2 })).toBeCloseTo(
      0.2,
      10,
    );
    expect(factorOverlayPostureAt({ direction: 'up', alpha: 0.5, posture: 2 })).toBe(1);
    expect(factorOverlayPostureAt({ direction: 'down', alpha: -0.5, posture: -1 })).toBe(0);
  });

  it('alpha 极端值 → 满仓/空仓（long-only 看空不建仓）', () => {
    expect(factorOverlayPostureAt({ direction: 'up', alpha: 1 })).toBe(1);
    expect(factorOverlayPostureAt({ direction: 'down', alpha: -1 })).toBe(0);
  });
});

describe('runBacktest 组合 alpha 叠加层（与新闻 AND 语义）', () => {
  it('不含因子叠加层 → factorAware=false、与基线一致', () => {
    const r = runBacktest(ohlcv, factorConfig());
    expect(r.factorAware).toBe(false);
    expect(r.tradeCount).toBeGreaterThan(0);
    expect(r.totalReturn).toBeGreaterThan(0);
  });

  it('因子看多（alpha>0）→ 缩仓但建仓，收益 < 基线、> 0', () => {
    const base = runBacktest(ohlcv, factorConfig());
    const up = runBacktest(ohlcv, factorConfig({ direction: 'up', alpha: 0.3 }));
    expect(up.factorAware).toBe(true);
    expect(up.factorDirection).toBe('up');
    expect(up.factorPosture).toBeCloseTo(0.65, 10);
    expect(up.tradeCount).toBe(base.tradeCount);
    expect(up.totalReturn).toBeLessThan(base.totalReturn);
    expect(up.totalReturn).toBeGreaterThan(0);
    expect(up.trades.some((t) => t.reason.includes('因子姿态65%'))).toBe(true);
  });

  it('因子看空（alpha=-1 → posture 0）→ 不建仓、收益≈0', () => {
    const down = runBacktest(ohlcv, factorConfig({ direction: 'down', alpha: -1 }));
    expect(down.factorAware).toBe(true);
    expect(down.factorDirection).toBe('down');
    expect(down.factorPosture).toBeCloseTo(0, 10);
    expect(down.tradeCount).toBe(0);
    expect(down.totalReturn).toBeCloseTo(0, 6);
  });

  it('因子中性（alpha=0 → posture 0.5）→ 半仓，收益介于 0 与基线之间', () => {
    const base = runBacktest(ohlcv, factorConfig());
    const neutral = runBacktest(ohlcv, factorConfig({ direction: 'neutral', alpha: 0 }));
    expect(neutral.factorPosture).toBeCloseTo(0.5, 10);
    expect(neutral.tradeCount).toBe(base.tradeCount);
    expect(neutral.totalReturn).toBeLessThan(base.totalReturn);
    expect(neutral.totalReturn).toBeGreaterThan(0);
  });

  it('与新闻叠加取较小值（AND）：新闻满仓 + 因子空仓 → 不建仓', () => {
    const bullNews = runBacktest(ohlcv, maConfig(1));
    expect(bullNews.tradeCount).toBeGreaterThan(0); // 仅新闻时正常建仓
    const combined = runBacktest(ohlcv, factorConfig({ direction: 'down', alpha: -1, posture: 0 }));
    // 向同一配置叠加新闻满仓：min(1, 0) = 0 → 不建仓
    const merged: StrategyConfig = {
      ...maConfig(1),
      factorOverlay: { direction: 'down', alpha: -1, posture: 0 },
    };
    const r = runBacktest(ohlcv, merged);
    expect(r.newsAware).toBe(true);
    expect(r.factorAware).toBe(true);
    expect(r.tradeCount).toBe(0);
    expect(r.totalReturn).toBeCloseTo(0, 6);
    expect(combined.tradeCount).toBe(0);
  });
});
