import { describe, it, expect } from 'vitest';
import { optimizeFactorWeights } from '../factorOptimizer.js';
import type { FactorPanelRow } from '../factorAnalytics.js';

/** mulberry32：固定 seed 伪随机（与 cscv.test.ts 同款），保证面板确定性 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 构造面板：factorA 强相关、factorB 弱相关、factorC 噪声（固定 seed，确定性） */
function buildPanel(n = 24, seed = 42): FactorPanelRow[] {
  const rand = mulberry32(seed);
  const rows: FactorPanelRow[] = [];
  for (let i = 0; i < n; i++) {
    const fwd = (i % 5) - 2; // 未来收益有结构
    rows.push({
      factors: {
        factorA: fwd + (rand() - 0.5) * 0.2, // 强
        factorB: fwd * 0.3 + (rand() - 0.5) * 0.5, // 弱
        factorC: (rand() - 0.5) * 2, // 噪声
      },
      forwardReturn: fwd,
    });
  }
  return rows;
}

describe('optimizeFactorWeights', () => {
  it('返回入选因子权重表，且权重和为 1', () => {
    const { weights, selected, report } = optimizeFactorWeights(buildPanel());
    expect(report.n).toBe(24); // 此前 toBeGreaterThanOrEqual(3) 对 n=24 恒真
    expect(selected.length).toBeGreaterThan(0);
    const sum = Object.values(weights).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 5);
  });

  it('强因子应获得不低于弱因子的权重', () => {
    const { weights, selected } = optimizeFactorWeights(buildPanel(60));
    // 固定 seed 后确定性成立：factorA（强）必然入选且权重大于等于 factorB（弱）。
    // 此前依赖随机抽样运气 + else 分支恒真（测试空转通过）
    expect(selected.some((s) => s.name === 'factorA')).toBe(true);
    expect(weights.factorA).toBeDefined();
    expect(weights.factorB).toBeDefined();
    expect(weights.factorA!).toBeGreaterThanOrEqual(weights.factorB!);
  });

  it('样本不足（<3）返回空权重表，不抛错', () => {
    const { weights, report } = optimizeFactorWeights([
      { factors: { a: 1 }, forwardReturn: 1 },
      { factors: { a: 2 }, forwardReturn: -1 },
    ]);
    expect(weights).toEqual({});
    expect(report.n).toBe(2);
  });

  it('空面板安全返回空结果', () => {
    const res = optimizeFactorWeights([]);
    expect(res.weights).toEqual({});
    expect(res.selected).toEqual([]);
    expect(res.report.n).toBe(0);
  });
});
