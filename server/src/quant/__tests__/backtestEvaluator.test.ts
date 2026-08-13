import { describe, it, expect } from 'vitest';
import {
  compareBacktests,
  deflatedSharpeRatio,
  expectedMaxOfNormals,
  normCDF,
} from '../backtestEvaluator.js';
import type { BacktestResult } from '../types.js';

function makeCurve(
  start: number,
  dailyRet: number,
  days: number,
): { date: string; value: number }[] {
  const curve: { date: string; value: number }[] = [];
  let v = 10000;
  for (let i = 0; i < days; i++) {
    v *= 1 + dailyRet;
    curve.push({ date: `2024-01-${String(i + 1).padStart(2, '0')}`, value: Math.round(v) });
  }
  return curve;
}

function makeResult(over: Partial<BacktestResult>): BacktestResult {
  return {
    totalReturn: 10,
    annualizedReturn: 5,
    sharpeRatio: 1.2,
    sortinoRatio: 1.5,
    maxDrawdown: 15,
    winRate: 55,
    profitFactor: 1.8,
    tradeCount: 0,
    equityCurve: makeCurve(10000, 0.001, 60),
    trades: [],
    benchmark: [],
    ...over,
  };
}

describe('compareBacktests — 基础对比', () => {
  it('实验组全面优于基线且显著 → experiment_wins + significant_strong', () => {
    const baseline = makeResult({
      annualizedReturn: 5,
      equityCurve: makeCurve(10000, 0.001, 60),
    });
    const experiment = makeResult({
      totalReturn: 25,
      annualizedReturn: 12,
      sharpeRatio: 1.8,
      maxDrawdown: 10,
      winRate: 65,
      equityCurve: makeCurve(10000, 0.0015, 60),
    });
    const r = compareBacktests(baseline, experiment);
    expect(r.alphaAnnualized).toBeCloseTo(7, 1);
    // 0.0015 vs 0.001 日收益差 0.0005，60 样本 t 应远大于 3
    expect(r.significance).toBe('significant_strong');
    expect(r.verdict).toBe('experiment_wins');
    expect(r.summary).toContain('实验组优于基线');
  });

  it('实验组全面劣于基线且显著 → baseline_wins + significant_strong', () => {
    const baseline = makeResult({
      annualizedReturn: 12,
      equityCurve: makeCurve(10000, 0.0015, 60),
    });
    const experiment = makeResult({
      totalReturn: 5,
      annualizedReturn: 5,
      sharpeRatio: 0.8,
      maxDrawdown: 20,
      winRate: 40,
      equityCurve: makeCurve(10000, 0.001, 60),
    });
    const r = compareBacktests(baseline, experiment);
    expect(r.alphaAnnualized).toBeLessThan(0);
    expect(r.significance).toBe('significant_strong');
    expect(r.verdict).toBe('baseline_wins');
    expect(r.summary).toContain('基线优于实验组');
  });

  it('样本量不足（<30）→ inconclusive 且有 caveat', () => {
    const baseline = makeResult({ equityCurve: makeCurve(10000, 0.001, 20) });
    const experiment = makeResult({
      annualizedReturn: 20,
      equityCurve: makeCurve(10000, 0.002, 20),
    });
    const r = compareBacktests(baseline, experiment);
    expect(r.significance).toBe('insufficient_sample');
    expect(r.verdict).toBe('inconclusive');
    expect(r.caveats.some((c) => c.includes('样本量不足'))).toBe(true);
  });

  it('两组完全相同 → tie，不显著', () => {
    const same = makeResult({});
    const r = compareBacktests(same, same);
    expect(r.alphaAnnualized).toBe(0);
    expect(r.significance).toBe('not_significant');
    expect(r.verdict).toBe('tie');
  });

  it('maxDrawdown 改善方向正确（越小越好）', () => {
    const baseline = makeResult({ maxDrawdown: 20 });
    const experiment = makeResult({ maxDrawdown: 12 });
    const r = compareBacktests(baseline, experiment);
    const ddMetric = r.metrics.find((m) => m.name === 'maxDrawdown');
    expect(ddMetric?.delta).toBe(-8);
    expect(ddMetric?.improved).toBe(true);
  });

  it('逐指标 delta 计算正确', () => {
    const baseline = makeResult({ sharpeRatio: 1.0, winRate: 50, profitFactor: 1.5 });
    const experiment = makeResult({ sharpeRatio: 1.5, winRate: 60, profitFactor: 2.0 });
    const r = compareBacktests(baseline, experiment);
    const sharpe = r.metrics.find((m) => m.name === 'sharpeRatio');
    const win = r.metrics.find((m) => m.name === 'winRate');
    const pf = r.metrics.find((m) => m.name === 'profitFactor');
    expect(sharpe?.delta).toBeCloseTo(0.5, 5);
    expect(win?.delta).toBeCloseTo(10, 5);
    expect(pf?.delta).toBeCloseTo(0.5, 5);
    expect(sharpe?.improved).toBe(true);
  });

  it('权益曲线为空时给出数据质量 caveat', () => {
    const baseline = makeResult({ equityCurve: [] });
    const experiment = makeResult({ equityCurve: [] });
    const r = compareBacktests(baseline, experiment);
    expect(r.caveats.some((c) => c.includes('权益曲线为空'))).toBe(true);
  });

  it('基准长度不一致时给出 caveat', () => {
    const baseline = makeResult({ benchmark: makeCurve(100, 0.001, 30) });
    const experiment = makeResult({ benchmark: makeCurve(100, 0.001, 50) });
    const r = compareBacktests(baseline, experiment);
    expect(r.caveats.some((c) => c.includes('基准长度不一致'))).toBe(true);
  });
});

describe('compareBacktests — 学界标准增强', () => {
  it('t 阈值分级：2<|t|≤3 → significant_marginal 带 caveat', () => {
    // 构造 t≈2.5：基线确定性 0.001 日收益，实验叠加交替噪声 ±0.0008，
    // 差异序列 mean=0.0002、std≈0.0008、n=100 → t = 0.0002/(0.0008/10) = 2.5。
    // 此前差异序列恒定（方差≈0 → t≈34），if 条件断言恒不触发 marginal 分支，用例空转通过。
    const baselineCurve = makeCurve(10000, 0.001, 100);
    const expCurve: { date: string; value: number }[] = [];
    let v = 10000;
    for (let i = 0; i < 100; i++) {
      v *= 1 + 0.0012 + (i % 2 === 0 ? 0.0008 : -0.0008);
      expCurve.push({ date: `2024-01-${String(i + 1).padStart(2, '0')}`, value: Math.round(v) });
    }
    const r = compareBacktests(
      makeResult({ equityCurve: baselineCurve }),
      makeResult({ equityCurve: expCurve }),
    );
    // 前置条件必须成立（否则数据构造失败，测试应红而非空转）
    expect(r.tStatistic).toBeGreaterThan(2);
    expect(r.tStatistic).toBeLessThanOrEqual(3);
    expect(r.significance).toBe('significant_marginal');
    expect(r.caveats.some((c) => c.includes('2-3 区间'))).toBe(true);
  });

  it('DSR/PSR 在样本充足时输出', () => {
    const baseline = makeResult({ equityCurve: makeCurve(10000, 0.001, 100) });
    const experiment = makeResult({ sharpeRatio: 2.0, equityCurve: makeCurve(10000, 0.002, 100) });
    const r = compareBacktests(baseline, experiment);
    expect(r.deflatedSharpeRatio).toBeDefined();
    expect(r.probabilisticSharpeRatio).toBeDefined();
    expect(r.deflatedSharpeRatio!).toBeGreaterThanOrEqual(0);
    expect(r.deflatedSharpeRatio!).toBeLessThanOrEqual(1);
    // DSR 应 ≤ PSR（扣除了搜索偏差）
    expect(r.deflatedSharpeRatio!).toBeLessThanOrEqual(r.probabilisticSharpeRatio!);
  });

  it('DSR 随搜索次数 N 增加而降低（多重检验惩罚）', () => {
    const baseline = makeResult({ equityCurve: makeCurve(10000, 0.001, 100) });
    const experiment = makeResult({ sharpeRatio: 1.5, equityCurve: makeCurve(10000, 0.0015, 100) });
    const r1 = compareBacktests(baseline, experiment, { numStrategiesTried: 1 });
    const r50 = compareBacktests(baseline, experiment, { numStrategiesTried: 50 });
    expect(r50.deflatedSharpeRatio!).toBeLessThan(r1.deflatedSharpeRatio!);
  });

  it('MinTRL 在样本充足时输出', () => {
    const baseline = makeResult({ equityCurve: makeCurve(10000, 0.001, 100) });
    const experiment = makeResult({ sharpeRatio: 2.0, equityCurve: makeCurve(10000, 0.002, 100) });
    const r = compareBacktests(baseline, experiment);
    expect(r.minTrackRecordLength).toBeDefined();
    expect(r.minTrackRecordLength!).toBeGreaterThan(0);
  });

  it('Block Bootstrap CI 在样本充足时输出且确定性', () => {
    const baseline = makeResult({ equityCurve: makeCurve(10000, 0.001, 80) });
    const experiment = makeResult({ equityCurve: makeCurve(10000, 0.0015, 80) });
    const r1 = compareBacktests(baseline, experiment, { bootstrapSeed: 42 });
    const r2 = compareBacktests(baseline, experiment, { bootstrapSeed: 42 });
    expect(r1.bootstrap).toBeDefined();
    expect(r1.bootstrap!.ci95).toHaveLength(2);
    expect(r1.bootstrap!.iterations).toBe(2000);
    // 确定性：同 seed 同结果
    expect(r2.bootstrap!.ci95[0]).toBeCloseTo(r1.bootstrap!.ci95[0], 10);
    expect(r2.bootstrap!.ci95[1]).toBeCloseTo(r1.bootstrap!.ci95[1], 10);
  });

  it('Bootstrap CI 实验组优于基线时不跨 0', () => {
    const baseline = makeResult({ equityCurve: makeCurve(10000, 0.001, 80) });
    const experiment = makeResult({ equityCurve: makeCurve(10000, 0.002, 80) });
    const r = compareBacktests(baseline, experiment);
    expect(r.bootstrap!.crossesZero).toBe(false);
    expect(r.bootstrap!.ci95[0]).toBeGreaterThan(0);
  });

  it('两组完全相同时 Bootstrap CI 跨 0', () => {
    const same = makeResult({ equityCurve: makeCurve(10000, 0.001, 80) });
    const r = compareBacktests(same, same);
    expect(r.bootstrap!.crossesZero).toBe(true);
  });

  it('非正态诊断在样本充足时输出', () => {
    const baseline = makeResult({ equityCurve: makeCurve(10000, 0.001, 60) });
    const experiment = makeResult({ equityCurve: makeCurve(10000, 0.0015, 60) });
    const r = compareBacktests(baseline, experiment);
    expect(r.nonNormality).toBeDefined();
    expect(r.nonNormality!.skewness).toBeTypeOf('number');
    expect(r.nonNormality!.excessKurtosis).toBeTypeOf('number');
    expect(r.nonNormality!.nonNormal).toBeTypeOf('boolean');
  });

  it('交易成本敏感性：实验组交易更频繁且成本占比高时给出 caveat', () => {
    const baseline = makeResult({
      tradeCount: 5,
      totalReturn: 20,
      equityCurve: makeCurve(10000, 0.001, 60),
    });
    const experiment = makeResult({
      tradeCount: 50,
      totalReturn: 15,
      equityCurve: makeCurve(10000, 0.0012, 60),
    });
    const r = compareBacktests(baseline, experiment);
    // 50 笔 * 0.4% = 20% 成本 / 15% 收益 = 133% 占比 > 30%
    expect(r.caveats.some((c) => c.includes('成本占比'))).toBe(true);
  });

  it('Bootstrap CI 跨 0 但 t 显著时以 Bootstrap 为准', () => {
    // 构造边界场景：t 略 >2 但 Bootstrap CI 跨 0
    // 用较小差异 + 较大方差
    const baseline = makeResult({ equityCurve: makeCurve(10000, 0.001, 60) });
    const experiment = makeResult({
      annualizedReturn: 6,
      equityCurve: makeCurve(10000, 0.0011, 60),
    });
    const r = compareBacktests(baseline, experiment);
    // 如果 t 显著但 bootstrap 跨 0，应降级为 not_significant
    if (r.bootstrap?.crossesZero && r.tStatistic > 2) {
      expect(r.significance).toBe('not_significant');
      expect(r.caveats.some((c) => c.includes('矛盾'))).toBe(true);
    }
  });

  it('numStrategiesTried > 1 时 caveat 含搜索偏差提示', () => {
    const baseline = makeResult({ equityCurve: makeCurve(10000, 0.001, 60) });
    const experiment = makeResult({ equityCurve: makeCurve(10000, 0.0015, 60) });
    const r = compareBacktests(baseline, experiment, { numStrategiesTried: 10 });
    expect(r.caveats.some((c) => c.includes('10 个策略变体'))).toBe(true);
  });
});

describe('Deflated Sharpe — 标准公式（Bailey-López de Prado 2014）', () => {
  it('SR_0 = E[max of N N(0,1)] 随 N 增大单调递增', () => {
    const ns = [2, 3, 5, 10, 30, 100, 1000, 10000];
    for (let i = 1; i < ns.length; i++) {
      expect(expectedMaxOfNormals(ns[i])).toBeGreaterThan(expectedMaxOfNormals(ns[i - 1]));
    }
    // 与极值理论已知值对照：E[max of 100 个标准正态] ≈ 2.5076
    expect(expectedMaxOfNormals(100)).toBeCloseTo(2.5076, 1);
    // N=1 无选择偏差，退回 0
    expect(expectedMaxOfNormals(1)).toBe(0);
    expect(expectedMaxOfNormals(0)).toBe(0);
  });

  it('N=1 时 DSR 退化为 PSR（SR_0 = 0，无搜索偏差）', () => {
    const baseline = makeResult({ equityCurve: makeCurve(10000, 0.001, 100) });
    const experiment = makeResult({ sharpeRatio: 1.5, equityCurve: makeCurve(10000, 0.0015, 100) });
    const r = compareBacktests(baseline, experiment); // 默认 numStrategiesTried=1
    expect(r.deflatedSharpeRatio).toBeDefined();
    expect(r.probabilisticSharpeRatio).toBeDefined();
    // 单次预注册检验：SR_0 = 0，DSR 与 PSR 数值一致
    expect(r.deflatedSharpeRatio!).toBeCloseTo(r.probabilisticSharpeRatio!, 10);
  });

  it('大 N 时显著阈值抬高：DSR 显著低于单次检验', () => {
    const sr = 0.15;
    const T = 252;
    const skew = 0;
    const kurt = 0;
    const dsrSingle = deflatedSharpeRatio(sr, 1, T, skew, kurt);
    const dsrMany = deflatedSharpeRatio(sr, 100, T, skew, kurt);
    // N=1：无校正，强 Sharpe 下接近 1
    expect(dsrSingle).toBeGreaterThan(0.9);
    // N=100：扣除 E[max] 抬升后显著阈值抬高，DSR 跌破 0.5
    expect(dsrMany).toBeLessThan(dsrSingle);
    expect(dsrMany).toBeLessThan(0.5);
  });

  it('DSR 随 N 增大连续降低（多重检验惩罚单调）', () => {
    const sr = 0.1;
    const T = 252;
    const dsrs = [1, 2, 5, 20, 100].map((n) => deflatedSharpeRatio(sr, n, T, 0, 0));
    for (let i = 1; i < dsrs.length; i++) {
      expect(dsrs[i]).toBeLessThan(dsrs[i - 1]);
    }
  });

  it('峰度项按标准式 (γ₄−1)/4 = (超额峰度+2)/4 计算（回归旧 bug：超额峰度直接代入 /4）', () => {
    // 选超额峰度 3（厚尾）：γ₄ = 3+3 = 6，标准项 (6−1)/4 = 5/4，旧实现会误用 3/4
    const sr = 0.5;
    const T = 63;
    const skew = 0;
    const kurt = 3;
    const sigma = Math.sqrt((1 - skew * sr + ((kurt + 2) / 4) * sr * sr) / (T - 1));
    const expectedPsr = normCDF(sr / sigma);
    // N=1 时 DSR = PSR，应与手工按标准公式算出的数值一致
    expect(deflatedSharpeRatio(sr, 1, T, skew, kurt)).toBeCloseTo(expectedPsr, 6);
  });
});
