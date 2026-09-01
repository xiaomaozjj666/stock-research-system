import { describe, it, expect } from 'vitest';
import type { OHLCVData } from '../types.js';
import {
  A_SHARE_FACTOR_EVIDENCE,
  A_SHARE_MONTHLY_COST,
  checkSampleHygiene,
  computePriceVolumeFactors,
  type PriceVolumeFactorName,
} from '../priceVolumeFactors.js';

/** 按给定价格序列构造日线；volume 可为序列或常数 */
function makeBars(prices: number[], volume: number | ((i: number) => number) = 1000): OHLCVData[] {
  return prices.map((p, i) => {
    const d = new Date(Date.UTC(2023, 0, 2));
    d.setUTCDate(d.getUTCDate() + i);
    return {
      date: d.toISOString().slice(0, 10),
      open: p,
      high: p,
      low: p,
      close: p,
      volume: typeof volume === 'function' ? volume(i) : volume,
    };
  });
}

/** 从日收益序列反推价格序列 */
function pricesFromReturns(rets: number[], start = 100): number[] {
  const out = [start];
  for (const r of rets) out.push(out[out.length - 1] * (1 + r));
  return out;
}

function factorOf(bars: OHLCVData[], name: PriceVolumeFactorName, marketReturns?: number[]) {
  const factors = computePriceVolumeFactors({ bars, marketReturns });
  const f = factors.find((x) => x.name === name)!;
  return f;
}

describe('反转类因子（A 股主导效应）', () => {
  it('reversal_1m 为近 21 日累计收益，方向为 −1', () => {
    const prices = Array.from({ length: 40 }, (_, i) => 100 * Math.pow(1.01, i));
    const f = factorOf(makeBars(prices), 'reversal_1m');
    expect(f.value).toBeGreaterThan(0);
    expect(f.direction).toBe(-1);
    expect(f.aShareAdjusted).toBe(true);
  });

  it('reversal_3m 为近 63 日累计收益，方向为 −1', () => {
    const prices = Array.from({ length: 100 }, (_, i) => 100 * Math.pow(1.005, i));
    const f = factorOf(makeBars(prices), 'reversal_3m');
    expect(f.value).toBeGreaterThan(0);
    expect(f.direction).toBe(-1);
  });

  it('下跌股票的反转因子值为负（配合 direction=−1 后得分仍为正）', () => {
    const prices = Array.from({ length: 40 }, (_, i) => 100 * Math.pow(0.99, i));
    const f = factorOf(makeBars(prices), 'reversal_1m');
    expect(f.value).toBeLessThan(0);
    expect(f.value * f.direction).toBeGreaterThan(0);
  });
});

describe('波动率类因子', () => {
  it('价格恒定时已实现波动率为 0', () => {
    const f = factorOf(makeBars(new Array(40).fill(100)), 'volatility_1m');
    expect(f.value).toBeCloseTo(0, 10);
  });

  it('波动越大因子值越高，方向为 −1（低波动异象）', () => {
    const calm = makeBars(pricesFromReturns(new Array(60).fill(0.001)));
    const wild = makeBars(
      pricesFromReturns(Array.from({ length: 60 }, (_, i) => (i % 2 ? 0.08 : -0.08))),
    );
    expect(factorOf(wild, 'volatility_1m').value).toBeGreaterThan(
      factorOf(calm, 'volatility_1m').value,
    );
    expect(factorOf(wild, 'volatility_1m').direction).toBe(-1);
  });

  it('年化口径：日波动 1% 对应约 15.9%', () => {
    // 交替 ±1% → 日收益标准差 = 1%
    const rets = Array.from({ length: 60 }, (_, i) => (i % 2 ? 0.01 : -0.01));
    const f = factorOf(makeBars(pricesFromReturns(rets)), 'volatility_1m');
    expect(f.value).toBeCloseTo(Math.sqrt(252) * 1, 0); // ≈ 15.87%
  });
});

describe('市场回归类因子（Beta / 特异波动率 / 残差动量）', () => {
  const market = Array.from({ length: 120 }, (_, i) => Math.sin(i * 0.7) * 0.01);

  it('个股收益 = 0.001 + 1.5×市场收益 时恢复出 beta = 1.5', () => {
    const rets = market.map((m) => 0.001 + 1.5 * m);
    const f = factorOf(makeBars(pricesFromReturns(rets)), 'beta', market);
    expect(f.value).toBeCloseTo(1.5, 6);
    expect(f.direction).toBe(-1);
  });

  it('无特异风险时特异波动率 ≈ 0', () => {
    const rets = market.map((m) => 0.001 + 1.5 * m);
    const f = factorOf(makeBars(pricesFromReturns(rets)), 'idiosyncratic_vol', market);
    expect(Math.abs(f.value)).toBeLessThan(1e-6);
  });

  it('加入特异噪声后特异波动率显著上升', () => {
    const clean = market.map((m) => 0.001 + 1.5 * m);
    const noisy = market.map((m, i) => 0.001 + 1.5 * m + (i % 2 ? 0.02 : -0.02));
    const a = factorOf(makeBars(pricesFromReturns(clean)), 'idiosyncratic_vol', market).value;
    const b = factorOf(makeBars(pricesFromReturns(noisy)), 'idiosyncratic_vol', market).value;
    expect(b).toBeGreaterThan(a);
  });

  it('残差动量需要 ≥147 个残差观测；数据足够时方向为 +1', () => {
    const long = Array.from({ length: 220 }, (_, i) => Math.sin(i * 0.5) * 0.01);
    const rets = long.map((m, i) => 1.2 * m + (i % 7 === 0 ? 0.005 : 0));
    const f = factorOf(makeBars(pricesFromReturns(rets)), 'residual_momentum_6m', long);
    expect(Number.isFinite(f.value)).toBe(true);
    expect(f.direction).toBe(1);
    expect(f.aShareAdjusted).toBe(true);
  });

  it('样本不足以支撑残差动量窗口时返回 NaN', () => {
    const rets = market.map((m) => 0.001 + 1.5 * m);
    const f = factorOf(makeBars(pricesFromReturns(rets)), 'residual_momentum_6m', market);
    expect(Number.isNaN(f.value)).toBe(true);
  });

  it('未提供市场收益时这三个因子为 NaN', () => {
    const bars = makeBars(pricesFromReturns(market.map((m) => 1.5 * m)));
    expect(Number.isNaN(factorOf(bars, 'beta').value)).toBe(true);
    expect(Number.isNaN(factorOf(bars, 'idiosyncratic_vol').value)).toBe(true);
    expect(Number.isNaN(factorOf(bars, 'residual_momentum_6m').value)).toBe(true);
  });
});

describe('换手与流动性因子', () => {
  it('近期成交量显著放大时换手率反转因子取负（方向为 +1，故得分为负）', () => {
    // 前 100 日成交 100 手，最后 20 日放大到 1000 手
    const prices = Array.from({ length: 130 }, () => 100);
    const bars = makeBars(prices, (i) => (i >= 110 ? 1000 : 100));
    const f = factorOf(bars, 'turnover_ratio_reversal');
    expect(f.value).toBeLessThan(0);
    expect(f.direction).toBe(1);
  });

  it('成交量持平时比值 ≈ 1，因子值 ≈ −1', () => {
    const f = factorOf(makeBars(new Array(130).fill(100), 500), 'turnover_ratio_reversal');
    expect(f.value).toBeCloseTo(-1, 6);
  });

  it('Amihud 非流动性：价格无波动时为 0，单位成交额的冲击越大因子值越高', () => {
    const flat = factorOf(makeBars(new Array(80).fill(100), 1000), 'amihud_illiquidity');
    expect(flat.value).toBeCloseTo(0, 12);
    const thin = factorOf(makeBars(new Array(80).fill(100), 10), 'amihud_illiquidity');
    // 成交额为 0 时同样无冲击（价格未变动）→ 两者均为 0，改为验证有波动时的单调性
    const rets = Array.from({ length: 80 }, (_, i) => (i % 2 ? 0.02 : -0.02));
    const liquid = factorOf(makeBars(pricesFromReturns(rets), 1e6), 'amihud_illiquidity').value;
    const illiquid = factorOf(makeBars(pricesFromReturns(rets), 100), 'amihud_illiquidity').value;
    expect(illiquid).toBeGreaterThan(liquid);
    expect(flat.value).toBe(0);
    expect(thin.value).toBe(0);
  });

  it('提供流通股本时使用真实换手率口径', () => {
    const prices = Array.from({ length: 130 }, () => 100);
    const bars = makeBars(prices, (i) => (i >= 110 ? 1000 : 100));
    const withFloat = computePriceVolumeFactors({ bars, floatShares: 1e8 }).find(
      (f) => f.name === 'turnover_ratio_reversal',
    )!;
    const withoutFloat = computePriceVolumeFactors({ bars }).find(
      (f) => f.name === 'turnover_ratio_reversal',
    )!;
    // 比值对整体缩放不敏感，两种口径结论一致
    expect(withFloat.value).toBeCloseTo(withoutFloat.value, 10);
  });
});

describe('彩票偏好与经典动量', () => {
  it('max_daily_return_1m 取近 21 日最大单日涨幅，方向为 −1', () => {
    const rets = Array.from({ length: 40 }, (_, i) => (i === 39 ? 0.09 : 0.001));
    const f = factorOf(makeBars(pricesFromReturns(rets)), 'max_daily_return_1m');
    expect(f.value).toBeCloseTo(9, 6);
    expect(f.direction).toBe(-1);
  });

  it('momentum_12_1 需 253 根 K 线；A 股方向为 −1（与美股相反）', () => {
    const prices = Array.from({ length: 300 }, (_, i) => 100 * Math.pow(1.002, i));
    const f = factorOf(makeBars(prices), 'momentum_12_1');
    expect(Number.isFinite(f.value)).toBe(true);
    expect(f.value).toBeGreaterThan(0);
    expect(f.direction).toBe(-1);
    expect(f.aShareAdjusted).toBe(true);
  });

  it('K 线不足 253 根时 momentum_12_1 为 NaN', () => {
    const f = factorOf(makeBars(new Array(200).fill(100)), 'momentum_12_1');
    expect(Number.isNaN(f.value)).toBe(true);
  });
});

describe('因子元数据', () => {
  it('A 股校正标记与方向一致：动量类被翻转，反转类被翻转', () => {
    expect(A_SHARE_FACTOR_EVIDENCE.momentum_12_1.direction).toBe(-1);
    expect(A_SHARE_FACTOR_EVIDENCE.residual_momentum_6m.direction).toBe(1);
    expect(A_SHARE_FACTOR_EVIDENCE.reversal_3m.direction).toBe(-1);
    expect(A_SHARE_FACTOR_EVIDENCE.volatility_1m.aShareAdjusted).toBe(false);
  });

  it('每个因子都带实证依据（可审计，非魔法常量）', () => {
    for (const meta of Object.values(A_SHARE_FACTOR_EVIDENCE)) {
      expect(meta.evidence.length).toBeGreaterThan(10);
      expect([1, -1]).toContain(meta.direction);
    }
  });

  it('全部因子均返回，数量与元数据表一致', () => {
    const factors = computePriceVolumeFactors({ bars: makeBars(new Array(300).fill(100)) });
    expect(factors).toHaveLength(Object.keys(A_SHARE_FACTOR_EVIDENCE).length);
  });
});

describe('checkSampleHygiene', () => {
  it('ST、停牌、次新股均被剔除', () => {
    expect(checkSampleHygiene({ isST: true }).exclude).toBe(true);
    expect(checkSampleHygiene({ isSuspended: true }).exclude).toBe(true);
    const v = checkSampleHygiene({ listingDate: '2024-01-01', asOf: '2024-02-01' });
    expect(v.exclude).toBe(true);
    expect(v.reasons[0]).toContain('次新股');
  });

  it('最小市值分位被剔除（壳价值污染）', () => {
    const v = checkSampleHygiene({ inSmallestDecile: true });
    expect(v.exclude).toBe(true);
    expect(v.reasons[0]).toContain('壳价值');
  });

  it('干净样本不剔除', () => {
    const v = checkSampleHygiene({ listingDate: '2020-01-01', asOf: '2024-01-01' });
    expect(v.exclude).toBe(false);
    expect(v.reasons).toEqual([]);
  });

  it('退市股不因退市本身被剔除（否则引入幸存者偏差）', () => {
    const v = checkSampleHygiene({ delisted: true });
    expect(v.exclude).toBe(false);
  });
});

describe('A_SHARE_MONTHLY_COST', () => {
  it('月度换仓总成本 = 佣金 + 印花税 + 冲击 + 滑点', () => {
    const c = A_SHARE_MONTHLY_COST;
    expect(c.perRebalance).toBeCloseTo(c.commission + c.stampDuty + c.impact + c.slippage, 12);
    // 分项相加为 0.43%/次。注：BigQuant 实证文中标注的「0.46%」与其自身分项
    // （0.03+0.10+0.20+0.10=0.43%）对不上，此处以分项为准，不照抄合计值。
    expect(c.perRebalance).toBeCloseTo(0.0043, 6);
    expect(c.perRebalance).toBeGreaterThan(0.003);
    expect(c.perRebalance).toBeLessThan(0.006);
  });
});
