import { afterEach, describe, expect, it, vi } from 'vitest';
import logger from '../../utils/logger.js';
import { runBacktest } from '../backtestEngine.js';
import { makeCostModel } from '../costModel.js';
import type { OHLCVData, StrategyConfig } from '../types.js';

/**
 * 深度审查缺陷修复的防御性测试（backtestEngine 侧）：
 * - H1：买入冲击成本纳入整手取整预算（现金不再透支）
 * - H3②：回测入口对 close 做有限性/正性预检（脏数据宁可报错）
 * - M1：params 显式 0 不被 || 吞成默认值
 * - M6：夏普等指标改用全精度权益序列计算（展示层仍 round）
 */

afterEach(() => {
  vi.restoreAllMocks();
});

/** 低价股 + 极清淡行情：bar0 收 10，bar1 起收 10.5（动量 +5%），日成交仅 100 手 = 1e4 股 */
function thinBars(n = 6): OHLCVData[] {
  const out: OHLCVData[] = [];
  const base = new Date('2025-01-01').getTime();
  for (let i = 0; i < n; i++) {
    const close = i === 0 ? 10 : 10.5;
    out.push({
      date: new Date(base + i * 86400000).toISOString().slice(0, 10),
      open: 10,
      close,
      high: Math.max(10, close) + 0.2,
      low: 9.8,
      volume: 100,
    });
  }
  return out;
}

/** 动量策略（lookback=1、buyThreshold=0：动量 > 0 即买——显式 0 同时覆盖 M1） */
function momentumCfg(over: Partial<StrategyConfig> = {}): StrategyConfig {
  return {
    name: '动量',
    type: 'momentum',
    stockCode: '600519',
    params: { lookback: 1, buyThreshold: 0 },
    startDate: '2025-01-01',
    endDate: '2025-01-31',
    ...over,
  };
}

describe('H1：买入冲击成本纳入整手预算（现金不透支）', () => {
  it('a_share + 小资金 + 低流动性：股数按「费率+冲击上限」预算取整，买入后现金 ≥ 0', () => {
    const bars = thinBars();
    const r = runBacktest(bars, momentumCfg({ initialCapital: 20000, costModel: 'a_share' }));

    // 信号 bar1（动量 +5% > 0）→ bar2 开盘成交：price = 10 × 1.001 = 10.01
    // 预算分母 = 10.01 × (1 + 0.00025 + 0.1) = 11.0135… → floor(20000/11.0135/100)×100 = 1800 股
    // （旧口径分母只含费率 → 1900 股 → 落账扣 total+impact 后现金为负）
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0].type).toBe('buy');
    expect(r.trades[0].date).toBe(bars[2].date);
    expect(r.trades[0].shares).toBe(1800);
    // 费用 = max(18018×0.00025, 5) + 0.1×(1800/10000)²×18018 = 5 + 58.378 → 63.38
    expect(r.trades[0].commission).toBe(63.38);

    // 现金不透支：equity（展示层 round，误差 ≤ 1 元） − 持仓市值 ≥ 0
    // 旧缺陷下该值为 −1136 量级，round 误差不可能掩盖
    const equityEst = (r.equityCurve[2].value / 100) * 20000;
    expect(equityEst - 1800 * 10.5).toBeGreaterThanOrEqual(0);
  });

  it('落账前复核不足（minCost 超预算）→ 按现金比例降档股数，reason 记录降档明细', () => {
    // minCost=1100 制造「预算估算够、落账不够」的场景（分母只考虑费率与冲击上限）：
    // 初始 200 股 → 复核 3102.08 > 2300 → 降档 100 股 → 复核 2101.10 ≤ 2300 成交
    const model = makeCostModel({
      openRate: 0.00025,
      closeRate: 0.00075,
      minCost: 1100,
      slippage: 0.001,
      impactCost: 0.1,
    });
    const r = runBacktest(thinBars(), momentumCfg({ initialCapital: 2300 }), model);

    expect(r.trades).toHaveLength(1);
    expect(r.trades[0].shares).toBe(100); // 200 → 100 降档
    // commission = max(1001×0.00025, 1100) + 0.1×(100/10000)²×1001 = 1100 + 0.01001 → 1100.01
    expect(r.trades[0].commission).toBe(1100.01);
    expect(r.trades[0].reason).toContain('降档：200→100股');

    // 降档成交后现金仍 ≥ 0
    const equityEst = (r.equityCurve[2].value / 100) * 2300;
    expect(equityEst - 100 * 10.5).toBeGreaterThanOrEqual(0);
  });

  it('降档后仍不足一手 → 跳过买入并告警（无成交记录、权益恒为初始值）', () => {
    const warnSpy = vi.spyOn(logger, 'warn');
    // 初始 100 股（预算 1105/11.0135=100.3 → 100），复核 1201.10 > 1105 →
    // 降档 floor(100×0.92/100)×100 = 0 → 不足一手，跳过
    const model = makeCostModel({
      openRate: 0.00025,
      closeRate: 0.00075,
      minCost: 200,
      slippage: 0.001,
      impactCost: 0.1,
    });
    const r = runBacktest(thinBars(), momentumCfg({ initialCapital: 1105 }), model);

    expect(r.tradeCount).toBe(0); // tradeCount 语义为成交数，跳过不留成交记录
    for (const p of r.equityCurve) expect(p.value).toBe(100); // 全程空仓
    expect(r.totalReturn).toBe(0);
    // 告警留痕（含降档前股数，便于审计）
    expect(warnSpy).toHaveBeenCalledWith(
      '买入预算复核不足一手，跳过买入',
      expect.objectContaining({ downgradedFrom: 100 }),
    );
  });

  it('simple 模型（无冲击系数）分母不含冲击上限，买入股数与历史口径一致', () => {
    const r = runBacktest(thinBars(), momentumCfg({ initialCapital: 20000 }));

    // 分母 = 10.01 × 1.0003 = 10.013 → floor(20000/10.013/100)×100 = 1900 股（修复前同值）
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0].shares).toBe(1900);
    // 费用 = 19019 × 0.0003 = 5.7057 → round 2 位 = 5.71
    expect(r.trades[0].commission).toBe(5.71);
  });
});

describe('H3②：回测入口脏数据预检（close 非有限或 ≤0 直接抛错）', () => {
  it('close=0 → 抛错，错误消息含 index 与值', () => {
    const bars = thinBars();
    bars[3] = { ...bars[3], close: 0 };
    expect(() => runBacktest(bars, momentumCfg())).toThrow(/index=3.*close=0/);
  });

  it('close=NaN → 抛错（旧行为：NaN 污染权益曲线但 totalReturn 静默显示 0）', () => {
    const bars = thinBars();
    bars[2] = { ...bars[2], close: Number.NaN };
    expect(() => runBacktest(bars, momentumCfg())).toThrow(/index=2.*close=NaN/);
  });

  it('close 为非数字类型 → 同样抛错（防御畸形外部输入）', () => {
    const bars = thinBars();
    (bars[1] as { close: unknown }).close = '10.5';
    expect(() => runBacktest(bars, momentumCfg())).toThrow(/index=1/);
  });

  it('正常数据与空序列零影响', () => {
    expect(() => runBacktest(thinBars(), momentumCfg())).not.toThrow();
    expect(() => runBacktest([], momentumCfg())).not.toThrow();
  });
});

describe('M1：params 显式 0 不被 || 吞成默认值', () => {
  it('buyThreshold=0 → 动量 > 0 即买（旧行为吞成 5% 时 +5% 动量不触发买入）', () => {
    const r = runBacktest(thinBars(), momentumCfg());
    expect(r.trades.filter((t) => t.type === 'buy')).toHaveLength(1);
  });

  it('sellDeviation=0 → 偏离均线 > 0 即卖（旧行为吞成 3% 时 2.2% 偏离不卖出）', () => {
    // 走平 → 跌破均线 −6.9%（买入）→ 回升到均线上方 +2.2%（< 默认 3%，显式 0 时应卖出）
    const closes = [10, 10, 10, 9, 9, 9, 9.3, 9.3];
    const bars: OHLCVData[] = closes.map((c, i) => ({
      date: `2025-01-${String(i + 1).padStart(2, '0')}`,
      open: c,
      close: c,
      high: c + 0.2,
      low: c - 0.2,
      volume: 100000,
    }));
    const cfg: StrategyConfig = {
      name: '均值回归',
      type: 'mean_reversion',
      stockCode: '600519',
      params: { maPeriod: 3, sellDeviation: 0 },
      startDate: '2025-01-01',
      endDate: '2025-01-31',
    };
    const r = runBacktest(bars, cfg);
    expect(r.trades.filter((t) => t.type === 'buy')).toHaveLength(1);
    expect(r.trades.filter((t) => t.type === 'sell')).toHaveLength(1);
  });
});

describe('M6：夏普等指标改用全精度权益序列计算', () => {
  /** 低波动行情：close 在 100.000/100.001 间交替，满仓权益日变化 ~±1e-5（相对） */
  function microVolBars(n = 100): OHLCVData[] {
    const out: OHLCVData[] = [];
    const base = new Date('2025-01-01').getTime();
    for (let i = 0; i < n; i++) {
      out.push({
        date: new Date(base + i * 86400000).toISOString().slice(0, 10),
        open: 100,
        close: 100 + (i % 2) * 0.001,
        high: 100.01,
        low: 99.99,
        volume: 1_000_000,
      });
    }
    return out;
  }

  it('低波动策略的夏普与全精度手工计算一致（预 round 会把波动抹平 → 旧口径恒为 0）', () => {
    const bars = microVolBars();
    const r = runBacktest(bars, momentumCfg());

    // —— 手工复算引擎同款全精度口径 ——
    const buy = r.trades.find((t) => t.type === 'buy')!;
    const buyIdx = bars.findIndex((b) => b.date === buy.date); // bar2
    expect(buyIdx).toBe(2);
    const fillPrice = 100 * 1.001; // bar2.open × (1+滑点)
    const shares = buy.shares; // floor(1e6/(100.1×1.0003)/100)×100 = 9900
    const cashAfter = 1_000_000 - shares * fillPrice * 1.0003; // fee = gross×0.0003
    const raw = bars.map((b, i) =>
      i < buyIdx ? 100 : ((cashAfter + shares * b.close) / 1_000_000) * 100,
    );
    const rets: number[] = [];
    for (let i = 1; i < raw.length; i++) rets.push((raw[i] - raw[i - 1]) / raw[i - 1]);
    const avg = rets.reduce((a, b) => a + b, 0) / rets.length;
    const std = Math.sqrt(rets.reduce((s, x) => s + (x - avg) ** 2, 0) / rets.length);
    const expectedSharpe = std > 0 ? ((avg - 0.025 / 252) / std) * Math.sqrt(252) : 0;

    // 引擎输出 = 全精度公式 round 2 位（一致）
    expect(r.sharpeRatio).toBe(Math.round(expectedSharpe * 100) / 100);
    // 修复佐证：预 round 的展示曲线在此数据下日收益恒为 0（差分恒等），
    // 若分析层仍用它，夏普必为 0 —— 非 0 即证明走的是全精度序列
    expect(r.sharpeRatio).not.toBe(0);
    // 展示层 equityCurve 仍为 round 2 位百分比（对外口径不变）
    for (const p of r.equityCurve) {
      expect(p.value).toBe(Math.round(p.value * 100) / 100);
    }
  });
});
