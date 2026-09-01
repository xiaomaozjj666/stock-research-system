import { describe, it, expect } from 'vitest';
import {
  spearmanRankIC,
  informationRatio,
  crossSectionalZScore,
  winsorize,
  selectOptimalFactors,
  compositeZ,
  zToScore,
  validateFactorModel,
  type FactorPanelRow,
} from '../factorAnalytics.js';

describe('spearmanRankIC', () => {
  it('完全单调一致时 IC = 1', () => {
    expect(spearmanRankIC([1, 2, 3, 4, 5], [10, 20, 30, 40, 50])).toBeCloseTo(1, 6);
  });
  it('完全反向时 IC = -1', () => {
    expect(spearmanRankIC([1, 2, 3, 4, 5], [50, 40, 30, 20, 10])).toBeCloseTo(-1, 6);
  });
  it('样本不足或长度不一致时返回 0', () => {
    expect(spearmanRankIC([1], [1])).toBe(0);
    expect(spearmanRankIC([1, 2], [1, 2, 3])).toBe(0);
  });
  it('处理并列秩（tie）不崩溃', () => {
    const ic = spearmanRankIC([1, 1, 2, 3], [1, 2, 3, 4]);
    expect(ic).toBeGreaterThanOrEqual(-1);
    expect(ic).toBeLessThanOrEqual(1);
  });
});

describe('informationRatio', () => {
  it('IC 序列完全稳定(std=0)时给极大 IR', () => {
    expect(informationRatio([0.1, 0.1, 0.1])).toBeGreaterThan(10);
  });
  it('IC 序列正负交替(高波动)时 IR 接近 0', () => {
    const ir = informationRatio([0.2, -0.2, 0.2, -0.2]);
    expect(Math.abs(ir)).toBeLessThan(1);
  });
  it('长度 < 2 返回 0', () => {
    expect(informationRatio([0.1])).toBe(0);
  });
});

describe('crossSectionalZScore', () => {
  it('零均值单位方差', () => {
    const z = crossSectionalZScore([1, 2, 3, 4, 5]);
    expect(z.reduce((a, b) => a + b, 0)).toBeCloseTo(0, 10);
    expect(Math.sqrt(z.reduce((s, v) => s + v * v, 0) / z.length)).toBeCloseTo(1, 10);
  });
  it('常数列避免除零（返回全 0）', () => {
    expect(crossSectionalZScore([7, 7, 7])).toEqual([0, 0, 0]);
  });
  it('空数组返回空', () => {
    expect(crossSectionalZScore([])).toEqual([]);
  });
});

describe('winsorize', () => {
  it('将两端极端值截断到分位', () => {
    const out = winsorize([1, 2, 3, 4, 5, 6, 7, 8, 9, 100], 0.1);
    // 第 10% 分位 ≈ 1.9，第 90% 分位 ≈ 91.9
    expect(out[out.length - 1]).toBeLessThan(100);
    expect(out[0]).toBeGreaterThan(1);
  });
  it('单元素/空安全', () => {
    expect(winsorize([5])).toEqual([5]);
    expect(winsorize([])).toEqual([]);
  });
});

describe('selectOptimalFactors', () => {
  it('剔除统计无效因子(|IC| 过低)', () => {
    const sel = selectOptimalFactors([
      { name: 'good', icSeries: [0.3, 0.35, 0.28] },
      { name: 'noise', icSeries: [0.005, -0.004, 0.006] },
    ]);
    expect(sel.map((s) => s.name)).toContain('good');
    expect(sel.map((s) => s.name)).not.toContain('noise');
  });
  it('权重与 |IR| 成正比且归一化 Σ=1', () => {
    const sel = selectOptimalFactors([
      { name: 'a', icSeries: [0.3, 0.32, 0.28] }, // IR 较高
      { name: 'b', icSeries: [0.1, 0.12, 0.08] }, // IR 较低
    ]);
    const sum = sel.reduce((s, f) => s + f.weight, 0);
    expect(sum).toBeCloseTo(1, 6);
    const a = sel.find((f) => f.name === 'a')!;
    const b = sel.find((f) => f.name === 'b')!;
    expect(a.weight).toBeGreaterThan(b.weight);
  });
  it('单截面 IC 时按 |IC| 加权（无 IR 可用）', () => {
    const sel = selectOptimalFactors([
      { name: 'strong', icSeries: [0.4] },
      { name: 'weak', icSeries: [0.1] },
    ]);
    expect(sel[0].name).toBe('strong');
    expect(sel.reduce((s, f) => s + f.weight, 0)).toBeCloseTo(1, 6);
    expect(sel.find((f) => f.name === 'strong')!.weight).toBeGreaterThan(
      sel.find((f) => f.name === 'weak')!.weight,
    );
  });
  it('全部无效时回退等权', () => {
    const sel = selectOptimalFactors([
      { name: 'x', icSeries: [0.001] },
      { name: 'y', icSeries: [-0.001] },
    ]);
    expect(sel).toHaveLength(2);
    expect(sel[0].weight).toBeCloseTo(0.5, 6);
  });
});

describe('compositeZ', () => {
  it('按权重合成 z', () => {
    expect(compositeZ({ a: 1, b: -1 }, { a: 0.5, b: 0.5 })).toBeCloseTo(0, 6);
    expect(compositeZ({ a: 2, b: 0 }, { a: 1, b: 0 })).toBeCloseTo(2, 6);
  });
  it('缺失因子跳过、权重和为 0 返回 0', () => {
    expect(compositeZ({ a: 5 }, { b: 1 })).toBe(0);
    expect(compositeZ({ a: 5 }, {})).toBe(0);
  });
});

describe('zToScore', () => {
  it('z=0 → max/2，单调有界', () => {
    expect(zToScore(0, 20)).toBe(10);
    expect(zToScore(-100, 20)).toBe(0);
    expect(zToScore(100, 20)).toBe(20);
  });
  it('单调递增', () => {
    expect(zToScore(1, 20)).toBeGreaterThan(zToScore(0, 20));
    expect(zToScore(0, 20)).toBeGreaterThan(zToScore(-1, 20));
  });
  it('非有限输入返回 0', () => {
    expect(zToScore(NaN, 20)).toBe(0);
    expect(zToScore(Infinity, 20)).toBe(20);
  });
});

describe('validateFactorModel', () => {
  // 构造面板：factorA 与收益强正相关，factorB 噪声，factorC 负相关
  const panel: FactorPanelRow[] = [
    { factors: { A: 5, B: 1, C: 1 }, forwardReturn: 0.3 },
    { factors: { A: 4, B: 9, C: 2 }, forwardReturn: 0.2 },
    { factors: { A: 3, B: 3, C: 3 }, forwardReturn: 0.05 },
    { factors: { A: 2, B: 7, C: 4 }, forwardReturn: -0.15 },
    { factors: { A: 1, B: 2, C: 5 }, forwardReturn: -0.25 },
  ];

  it('有效因子 A 入选且权重高于噪声 B', () => {
    const rep = validateFactorModel(panel);
    expect(rep.n).toBe(5);
    const a = rep.perFactor.find((f) => f.name === 'A')!;
    const b = rep.perFactor.find((f) => f.name === 'B')!;
    expect(a.selected).toBe(true);
    // A 与收益强正相关，IC 幅度应显著大于近噪声的 B
    expect(Math.abs(a.ic)).toBeGreaterThan(Math.abs(b.ic));
    // 最优加权下 A 的权重更高
    expect(a.weight).toBeGreaterThan(b.weight);
  });

  it('方向准确率 ∈ [0,1] 且 RMSE ≥ 0', () => {
    const rep = validateFactorModel(panel);
    expect(rep.directionalAccuracy).toBeGreaterThanOrEqual(0);
    expect(rep.directionalAccuracy).toBeLessThanOrEqual(1);
    expect(rep.rmse).toBeGreaterThanOrEqual(0);
  });

  it('样本不足时返回空报告', () => {
    const rep = validateFactorModel(panel.slice(0, 2));
    expect(rep.n).toBe(2);
    expect(rep.perFactor).toHaveLength(0);
  });
});

describe('validateFactorModel 每日截面 IC 序列（qlib calc_ic 口径）', () => {
  // 两个交易日 × 3 只股票：A 因子在每天截面内与收益排序一致（强因子），B 为噪声
  const dailyPanel: FactorPanelRow[] = [
    { date: '2025-01-02', factors: { A: 3, B: 5 }, forwardReturn: 0.3 },
    { date: '2025-01-02', factors: { A: 2, B: 9 }, forwardReturn: 0.1 },
    { date: '2025-01-02', factors: { A: 1, B: 1 }, forwardReturn: -0.2 },
    { date: '2025-01-03', factors: { A: 3, B: 7 }, forwardReturn: 0.25 },
    { date: '2025-01-03', factors: { A: 2, B: 2 }, forwardReturn: 0.0 },
    { date: '2025-01-03', factors: { A: 1, B: 8 }, forwardReturn: -0.3 },
  ];

  it('按日分组计算 IC 序列：A 因子每日截面 IC ≈ +1，B 为噪声 IC 弱', () => {
    const rep = validateFactorModel(dailyPanel);
    expect(rep.n).toBe(6);
    const a = rep.perFactor.find((f) => f.name === 'A')!;
    const b = rep.perFactor.find((f) => f.name === 'B')!;
    // A：每日内因子值与收益完全同序 → 每日 IC = 1 → 平均 IC ≈ 1
    expect(a.ic).toBeCloseTo(1, 6);
    expect(Math.abs(a.ic)).toBeGreaterThan(Math.abs(b.ic));
  });

  it('多截面 IC 序列可计算 ICIR（= mean/std），单截面时缺省', () => {
    const rep = validateFactorModel(dailyPanel);
    const a = rep.perFactor.find((f) => f.name === 'A')!;
    // 每日 IC 恒为 1 → std=0 → informationRatio 返回符号 99
    expect(a.icir).toBe(99);
    // 无 date 的旧面板：单 IC，icir 缺省
    const legacy = validateFactorModel([
      { factors: { A: 1 }, forwardReturn: 0.1 },
      { factors: { A: 2 }, forwardReturn: 0.2 },
      { factors: { A: 3 }, forwardReturn: 0.3 },
    ]);
    expect(legacy.perFactor[0].icir).toBeUndefined();
  });

  it('混合口径差异：跨期秩混合的单 IC ≠ 每日截面平均 IC（A 因子跨日排序与收益不同序）', () => {
    // 构造日内同序（每天 A 升→收益升，日内 IC=+1）但跨日整体偏移（01-02 的 A 值整体高于
    // 01-03，收益水平却与之错位）——跨期混合秩相关被拉低，按日截面口径仍为 +1
    const panel: FactorPanelRow[] = [
      { date: '2025-01-02', factors: { A: 4 }, forwardReturn: -0.2 },
      { date: '2025-01-02', factors: { A: 5 }, forwardReturn: 0.1 },
      { date: '2025-01-02', factors: { A: 6 }, forwardReturn: 0.3 },
      { date: '2025-01-03', factors: { A: 1 }, forwardReturn: -0.3 },
      { date: '2025-01-03', factors: { A: 2 }, forwardReturn: 0.0 },
      { date: '2025-01-03', factors: { A: 3 }, forwardReturn: 0.25 },
    ];
    const rep = validateFactorModel(panel);
    const a = rep.perFactor.find((f) => f.name === 'A')!;
    // 按日口径：每日 IC = +1（日内同序）→ 平均 IC = 1
    expect(a.ic).toBeCloseTo(1, 6);
    // 全样本混合口径：跨期秩混合 → IC 明显低于 1
    const mixed = spearmanRankIC(
      panel.map((r) => r.factors.A),
      panel.map((r) => r.forwardReturn),
    );
    expect(mixed).toBeLessThan(a.ic);
    expect(mixed).toBeLessThan(1);
  });

  it('某日样本不足 2 行时跳过该日（不参与 IC 序列）', () => {
    const panel: FactorPanelRow[] = [
      { date: '2025-01-02', factors: { A: 2 }, forwardReturn: 0.1 },
      { date: '2025-01-02', factors: { A: 1 }, forwardReturn: -0.1 },
      { date: '2025-01-03', factors: { A: 5 }, forwardReturn: 0.5 }, // 单行日 → 跳过
    ];
    const rep = validateFactorModel(panel);
    const a = rep.perFactor.find((f) => f.name === 'A')!;
    // 只用 01-02 的 2 行 → 单截面 IC，icir 缺省
    expect(a.icir).toBeUndefined();
    expect(a.ic).toBeCloseTo(1, 6);
  });
});

describe('validateFactorModel 缺失值处理', () => {
  const base: FactorPanelRow[] = [
    { date: '2025-01-02', factors: { A: 3 }, forwardReturn: 0.3 },
    { date: '2025-01-02', factors: { A: 2 }, forwardReturn: 0.2 },
    { date: '2025-01-02', factors: { A: 1 }, forwardReturn: -0.2 },
    { date: '2025-01-02', factors: { A: NaN }, forwardReturn: 0.9 },
  ];

  it('缺失因子值的行被丢弃，而不是当成 0 参与计算', () => {
    // 回归测试：此前 `row.factors[name] ?? 0` 把 NaN 当 0，等价于给「数据缺失」
    // 的标的安了一个偏低的因子值，会系统性污染 IC 方向与权重。
    const rep = validateFactorModel(base, { maxLoss: 0.5 });
    expect(rep.n).toBe(4);
    expect(rep.dropped).toBe(1);
    expect(rep.used).toBe(3);
  });

  it('丢弃后 IC 不受缺失行的干扰（缺失行的极端收益被排除）', () => {
    const rep = validateFactorModel(base, { maxLoss: 0.5 });
    const a = rep.perFactor.find((f) => f.name === 'A')!;
    // 保留的 3 行因子值与收益完全同序 → IC = 1
    expect(a.ic).toBeCloseTo(1, 6);
  });

  it('因子键不存在的行同样被丢弃', () => {
    const panel: FactorPanelRow[] = [
      { date: 'd1', factors: { A: 3 }, forwardReturn: 0.3 },
      { date: 'd1', factors: { A: 2 }, forwardReturn: 0.2 },
      { date: 'd1', factors: { A: 1 }, forwardReturn: 0.1 },
      { date: 'd1', factors: {}, forwardReturn: 0.9 },
    ];
    const rep = validateFactorModel(panel, { maxLoss: 0.5 });
    expect(rep.used).toBe(3);
    expect(rep.dropped).toBe(1);
  });

  it('丢弃比例超过 maxLoss 时抛错（不静默接受大面积缺失）', () => {
    // base 丢弃比例恰为 25%：「maxLoss = 允许丢弃的最大比例」，等于阈值时放行，
    // 严格超过才抛错（与 alphalens `dropped > max_loss` 口径一致）
    expect(() => validateFactorModel(base, { maxLoss: 0.2 })).toThrow(/maxLoss/);
    expect(() => validateFactorModel(base, { maxLoss: 0.9 })).not.toThrow();
    expect(() => validateFactorModel(base)).not.toThrow();
  });

  it('无缺失时 dropped = 0，used = n', () => {
    const rep = validateFactorModel(base.slice(0, 3));
    expect(rep.dropped).toBe(0);
    expect(rep.used).toBe(3);
  });

  it('样本不足提前返回时 used = 0', () => {
    const rep = validateFactorModel(base.slice(0, 2));
    expect(rep.used).toBe(0);
    expect(rep.dropped).toBe(2);
  });
});
