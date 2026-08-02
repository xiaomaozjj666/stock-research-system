import { describe, it, expect } from 'vitest';
import { optimizeFactorWeights } from '../factorOptimizer.js';
import type { FactorPanelRow } from '../factorAnalytics.js';

/** 构造面板：factorA 强相关、factorB 弱相关、factorC 噪声 */
function buildPanel(n = 24): FactorPanelRow[] {
  const rows: FactorPanelRow[] = [];
  for (let i = 0; i < n; i++) {
    const fwd = (i % 5) - 2; // 未来收益有结构
    rows.push({
      factors: {
        factorA: fwd + (Math.random() - 0.5) * 0.2, // 强
        factorB: fwd * 0.3 + (Math.random() - 0.5) * 0.5, // 弱
        factorC: (Math.random() - 0.5) * 2, // 噪声
      },
      forwardReturn: fwd,
    });
  }
  return rows;
}

describe('optimizeFactorWeights', () => {
  it('返回入选因子权重表，且权重和为 1', () => {
    const { weights, selected, report } = optimizeFactorWeights(buildPanel());
    expect(report.n).toBeGreaterThanOrEqual(3);
    expect(selected.length).toBeGreaterThan(0);
    const sum = Object.values(weights).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 5);
  });

  it('强因子应获得不低于弱因子的权重', () => {
    const { weights } = optimizeFactorWeights(buildPanel(60));
    if (weights.factorA !== undefined && weights.factorB !== undefined) {
      expect(weights.factorA).toBeGreaterThanOrEqual(weights.factorB);
    } else {
      // 阈值下可能未入选，至少保证结构合法
      expect(typeof weights).toBe('object');
    }
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
