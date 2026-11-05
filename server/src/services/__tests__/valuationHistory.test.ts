import { describe, expect, it } from 'vitest';
import type { ValuationData } from '../../types.js';
import { historicalPEPercentile } from '../valuationHistory.js';

function valuation(historicalPE: ValuationData['historicalPE']): ValuationData {
  return {
    currentPrice: 100,
    pe: 20,
    pb: 2,
    ps: 3,
    marketCap: 1000,
    historicalPE,
    peerComparison: [],
  };
}

describe('historicalPEPercentile', () => {
  it('空历史数组返回数据不足而非 NaN', () => {
    expect(historicalPEPercentile(valuation([]))).toBeNull();
  });

  it('估算序列与单个当前 PE 不参与历史分位', () => {
    const result = historicalPEPercentile(
      valuation([
        { year: '2024', pe: 30, isEstimated: true },
        { year: '2025', pe: 25, isEstimated: true },
        { year: '2026', pe: 20, isEstimated: false },
      ]),
    );
    expect(result).toBeNull();
  });

  it('仅使用真实历史观测计算分位', () => {
    const result = historicalPEPercentile(
      valuation([
        { year: '2023', pe: 10 },
        { year: '2024', pe: 30, isEstimated: false },
        { year: '2025', pe: 999, isEstimated: true },
        { year: '2026', pe: 20 },
      ]),
    );
    expect(result).toBeCloseTo((2 / 3) * 100, 8);
  });

  it('当前 PE 无效时不生成分位', () => {
    const input = valuation([
      { year: '2024', pe: 10 },
      { year: '2025', pe: 30 },
    ]);
    input.pe = 0;
    input.peUnavailable = true;
    expect(historicalPEPercentile(input)).toBeNull();
  });
});
