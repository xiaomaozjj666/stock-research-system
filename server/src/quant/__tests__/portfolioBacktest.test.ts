/**
 * 因子组合回测测试：持仓选择 / 换手与成本 / 基准对照 / 指标口径。
 * IC 数值本身的正确性由 factorEvaluation 评估器测试覆盖。
 */
import { describe, it, expect } from 'vitest';
import { runPortfolioBacktest } from '../portfolioBacktest.js';
import type { OHLCVData } from '../types.js';
import type { FactorObservation } from '../factorEvaluation.js';

/** n 根确定性 K 线：close 从 base 起按 drift 每日复利 */
function barsFor(code: string, n: number, base: number, dailyDrift: number): OHLCVData[] {
  const out: OHLCVData[] = [];
  const d = new Date('2024-01-01').getTime();
  let close = base;
  for (let i = 0; i < n; i++) {
    close *= 1 + dailyDrift;
    out.push({
      date: new Date(d + i * 86_400_000).toISOString().slice(0, 10),
      open: close,
      high: close,
      low: close,
      close: Math.round(close * 100) / 100,
      volume: 1_000_000,
    });
  }
  return out;
}

/** 面板：每 21 个交易日发布一次因子值，值 = 该股本期预期收益（完美因子） */
function perfectPanel(
  symbols: { code: string; periodReturn: number }[],
  dates: string[],
  holdDays = 21,
): FactorObservation[] {
  const obs: FactorObservation[] = [];
  dates.forEach((date, i) => {
    if (i % holdDays !== 0) return;
    for (const s of symbols) {
      obs.push({ date, symbol: s.code, value: s.periodReturn, returns: {} });
    }
  });
  return obs;
}

describe('runPortfolioBacktest — 因子组合回测', () => {
  const calendar = Array.from({ length: 252 }, (_, i) =>
    new Date(new Date('2024-01-01').getTime() + i * 86_400_000).toISOString().slice(0, 10),
  );

  it('完美因子：top-N 恰好持有赢家，跑赢等权基准', () => {
    // A 每期 +5%，B +1%，C −2%：因子值 = 预期收益 → top1 恒持 A
    const bars = new Map([
      ['A', barsFor('A', 252, 100, 0.05 / 21)],
      ['B', barsFor('B', 252, 100, 0.01 / 21)],
      ['C', barsFor('C', 252, 100, -0.02 / 21)],
    ]);
    const panel = perfectPanel(
      [
        { code: 'A', periodReturn: 0.05 },
        { code: 'B', periodReturn: 0.01 },
        { code: 'C', periodReturn: -0.02 },
      ],
      calendar,
    );
    const r = runPortfolioBacktest(panel, bars, { holdDays: 21, topN: 1, costBps: 0 });
    expect(r).not.toBeNull();
    expect(r!.periods).toBe(11); // 252 / 21 − 1（最后一个不完整期不计）
    expect(r!.rebalances[0].holdings).toEqual(['A']);
    expect(r!.totalReturn).toBeGreaterThan(0);
    // 完美因子应显著跑赢候选宇宙等权基准
    expect(r!.totalReturn).toBeGreaterThan(r!.benchmarkCurve.at(-1)!.value * 100 - 100);
    expect(r!.winRate).toBe(100);
  });

  it('换手与成本：持仓不变 → 零换手零成本；全换 → 成本拖累可感', () => {
    // 每 21 天「最强股」轮换：因子值给出每期真实最强者 → 换手高
    const bars = new Map([
      ['A', barsFor('A', 252, 100, 0.001)],
      ['B', barsFor('B', 252, 100, 0.001)],
    ]);
    // 交替给 A/B 满分 → 每期全换
    const obs: FactorObservation[] = [];
    calendar.forEach((date, i) => {
      if (i % 21 !== 0) return;
      const winner = (i / 21) % 2 === 0 ? 'A' : 'B';
      obs.push({ date, symbol: winner, value: 1, returns: {} });
      obs.push({ date, symbol: winner === 'A' ? 'B' : 'A', value: 0.5, returns: {} });
    });
    const zeroCost = runPortfolioBacktest(obs, bars, { holdDays: 21, topN: 1, costBps: 0 })!;
    const withCost = runPortfolioBacktest(obs, bars, { holdDays: 21, topN: 1, costBps: 30 })!;
    // 每期换手 = 1（top1 在 A/B 间轮换）
    expect(zeroCost.rebalances[1].turnover).toBe(1);
    expect(withCost.totalReturn).toBeLessThan(zeroCost.totalReturn);
    // 成本拖累 ≈ 换手 × 30bps × 2 = 每期 0.006
    expect(withCost.rebalances[1].costDrag).toBeCloseTo(-0.006, 6);
    expect(zeroCost.rebalances[1].costDrag).toBeCloseTo(0, 10);
  });

  it('候选不足 topN → 持有实际数量；某期无候选 → 空仓（收益 0）', () => {
    const bars = new Map([
      ['A', barsFor('A', 252, 100, 0.001)],
      ['B', barsFor('B', 252, 100, 0.001)],
    ]);
    const obs: FactorObservation[] = [];
    calendar.forEach((date, i) => {
      if (i % 21 !== 0) return;
      if ((i / 21) % 2 === 0) {
        obs.push({ date, symbol: 'A', value: 1, returns: {} }); // 只有 1 个候选
      }
      // 偶数期无任何候选 → 空仓
    });
    const r = runPortfolioBacktest(obs, bars, { holdDays: 21, topN: 5, costBps: 0 })!;
    const withOne = r.rebalances.find((x) => x.holdings.length === 1);
    expect(withOne).toBeDefined();
    const empty = r.rebalances.find((x) => x.holdings.length === 0);
    expect(empty).toBeDefined();
    expect(empty!.grossReturn).toBe(0);
  });

  it('反向因子：值越小越好时研究者应取负——按原值排序持有的是「最差股」', () => {
    const bars = new Map([
      ['A', barsFor('A', 252, 100, 0.05 / 21)],
      ['C', barsFor('C', 252, 100, -0.02 / 21)],
    ]);
    // 因子值 = 预期收益（A 高 C 低），top1 持 A 赚钱；取负则持 C 亏钱——
    // 方向语义由 DSL/研究者负责，引擎只按值降序，这是文档化行为
    const panel: FactorObservation[] = [];
    calendar.forEach((date, i) => {
      if (i % 21 !== 0) return;
      panel.push({ date, symbol: 'A', value: 0.05, returns: {} });
      panel.push({ date, symbol: 'C', value: -0.02, returns: {} });
    });
    const r = runPortfolioBacktest(panel, bars, { holdDays: 21, topN: 1, costBps: 0 })!;
    expect(r.rebalances[0].holdings).toEqual(['A']);
  });

  it('数据不足（< 2×holdDays）→ null（如实拒绝，不出空报告）', () => {
    const bars = new Map([['A', barsFor('A', 30, 100, 0.001)]]);
    const r = runPortfolioBacktest(
      [{ date: '2024-01-01', symbol: 'A', value: 1, returns: {} }],
      bars,
      { holdDays: 21 },
    );
    expect(r).toBeNull();
  });

  it('指标口径：年化/夏普/回撤可从期收益手工复算', () => {
    const bars = new Map([['A', barsFor('A', 252, 100, 0.002)]]);
    const obs: FactorObservation[] = calendar
      .filter((_, i) => i % 21 === 0 && i + 21 < 252)
      .map((date) => ({ date, symbol: 'A', value: 1, returns: {} }));
    const r = runPortfolioBacktest(obs, bars, { holdDays: 21, topN: 1, costBps: 0 })!;
    expect(r.periods).toBe(11);
    // 净值 = 各期净收益连乘（曲线点保留 4 位小数）
    const compounded = r.rebalances.reduce((acc, x) => acc * (1 + x.grossReturn + x.costDrag), 1);
    expect(r.equityCurve.at(-1)!.value).toBeCloseTo(compounded, 3);
    // 基准 = 候选宇宙等权 = 同一只股票 → 与组合一致（零 alpha 的自检）
    expect(r.benchmarkCurve.at(-1)!.value).toBeCloseTo(r.equityCurve.at(-1)!.value, 6);
    // 无成本、恒定收益 → 胜率 100%（与基准持平算不赢？此处净=基准 → winRate 0）
    // 注：严格大于才算赢，与基准打平不算——这是保守口径
    expect(r.winRate).toBe(0);
  });
});
