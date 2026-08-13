import { describe, it, expect } from 'vitest';
import {
  normalizeFactor,
  desirabilityToZ,
  extractFactors,
  buildFactorZScores,
  groupFactorsByDimension,
} from '../factors.js';
import type { FinancialData, ValuationData, StockInfo } from '../../types.js';

function makeFinancial(overrides: Partial<FinancialData> = {}): FinancialData {
  const years = ['2020', '2021', '2022', '2023', '2024', '2025'];
  const base: FinancialData = {
    years,
    revenue: [100, 120, 140, 160, 180, 200],
    netProfit: [30, 36, 42, 48, 54, 60],
    grossMargin: [90, 90, 90, 90, 90, 90],
    netMargin: [30, 30, 30, 30, 30, 30],
    roe: [30, 30, 30, 30, 30, 30],
    operatingCashFlow: [35, 40, 45, 50, 55, 60],
    eps: [1, 1.2, 1.4, 1.6, 1.8, 2],
    totalAssets: [500, 520, 540, 560, 580, 600],
    totalLiabilities: [150, 155, 160, 165, 170, 175],
    equity: [350, 365, 380, 395, 410, 425],
    accountsReceivable: [5, 5, 5, 5, 5, 5],
    inventory: [20, 20, 20, 20, 20, 20],
    goodwill: [0, 0, 0, 0, 0, 0],
    debtRatio: [30, 30, 30, 30, 30, 30],
  };
  return { ...base, ...overrides };
}

const valuation: ValuationData = {
  currentPrice: 100,
  pe: 20,
  pb: 5,
  ps: 8,
  marketCap: 2000,
  historicalPE: [
    { year: '2021', pe: 25 },
    { year: '2022', pe: 24 },
    { year: '2023', pe: 23 },
    { year: '2024', pe: 22 },
    { year: '2025', pe: 21 },
    { year: '2026', pe: 20 },
  ],
  peerComparison: [],
};

const info: StockInfo = {
  code: '600519',
  name: '测试股',
  industry: '白酒',
  market: '上交所主板',
  listingDate: '',
  description: '',
};

describe('normalizeFactor', () => {
  it('neutral 处 desirability = 0.5', () => {
    expect(normalizeFactor(30, 1, 30, 30)).toBeCloseTo(0.5, 6);
    expect(normalizeFactor(10, -1, 10, 5)).toBeCloseTo(0.5, 6);
  });
  it('越高越好：值高于 neutral 时合意度 > 0.5', () => {
    expect(normalizeFactor(60, 1, 30, 30)).toBeGreaterThan(0.5);
    expect(normalizeFactor(0, 1, 30, 30)).toBeLessThan(0.5);
  });
  it('越低越好：值高于 neutral 时合意度 < 0.5', () => {
    expect(normalizeFactor(50, -1, 20, 30)).toBeLessThan(0.5);
    expect(normalizeFactor(5, -1, 20, 30)).toBeGreaterThan(0.5);
  });
  it('退化输入(scale=0/非有限)返回 0.5 不崩溃', () => {
    expect(normalizeFactor(10, 1, 5, 0)).toBe(0.5);
    expect(normalizeFactor(NaN, 1, 5, 10)).toBe(0.5);
  });
});

describe('desirabilityToZ', () => {
  it('0.5 → 0，单调', () => {
    expect(desirabilityToZ(0.5)).toBeCloseTo(0, 6);
    expect(desirabilityToZ(0.9)).toBeGreaterThan(desirabilityToZ(0.5));
    expect(desirabilityToZ(0.1)).toBeLessThan(0);
  });
});

describe('extractFactors', () => {
  it('抽取五大维度共 21 个因子', () => {
    const fs = extractFactors(makeFinancial(), valuation, info);
    expect(fs.length).toBe(21);
    const grouped = groupFactorsByDimension(fs);
    expect(grouped.profit.length).toBe(5);
    expect(grouped.growth.length).toBe(4);
    expect(grouped.valuation.length).toBe(5);
    expect(grouped.industry.length).toBe(2);
    expect(grouped.risk.length).toBe(5);
  });
  it('高毛利股 grossMargin 因子值高于中性点', () => {
    const fs = extractFactors(makeFinancial(), valuation, info);
    const gm = fs.find((f) => f.name === 'grossMargin')!;
    expect(gm.value).toBe(90);
    expect(normalizeFactor(gm.value, gm.direction, gm.neutral, gm.scale)).toBeGreaterThan(0.5);
  });
  it('高负债行业债务风险得分中性化（银行 91% 不应判为极差）', () => {
    const bank = extractFactors(makeFinancial({ debtRatio: [90, 90, 91, 91, 91, 91] }), valuation, {
      ...info,
      industry: '银行',
    });
    const debt = bank.find((f) => f.name === 'debtRiskScore')!;
    // 银行基准 92%：91% 在危险线(115%)之下，得部分分；制造业同负债则归零。
    const asManufacturer = extractFactors(
      makeFinancial({ debtRatio: [91, 91, 91, 91, 91, 91] }),
      valuation,
      { ...info, industry: '制造业' },
    );
    const debtM = asManufacturer.find((f) => f.name === 'debtRiskScore')!;
    expect(debt.value).toBeGreaterThan(debtM.value);
    expect(debt.value).toBeGreaterThan(0);
    expect(debt.value).toBeLessThanOrEqual(7);
  });
});

describe('buildFactorZScores', () => {
  it('默认路径：logit(z)，方向与合意度一致', () => {
    const fs = extractFactors(makeFinancial(), valuation, info);
    const z = buildFactorZScores(fs);
    expect(z.grossMargin).toBeGreaterThan(0); // 高毛利 → 正 z
    // 股票 PE 处于历史低位(约 17% 分位，低估) → pePercentile 因子(dir=-1)合意度高 → 正 z
    expect(z.pePercentile).toBeGreaterThan(0);
  });
  it('截面路径：相对同业 z 标准化', () => {
    const fs = extractFactors(
      makeFinancial(),
      {
        ...valuation,
        peerComparison: [
          { name: 'A', code: '1', pe: 25, pb: 4, roe: 20, marketCap: 1000 },
          { name: 'B', code: '2', pe: 30, pb: 4, roe: 20, marketCap: 1000 },
        ],
      },
      info,
    );
    const z = buildFactorZScores(fs, { roe: [20, 20] });
    // 本股 roe=30，同业=[20,20]，应为正 z
    expect(z.roe).toBeGreaterThan(0);
  });
  it('截面常数（std=0）返回 0', () => {
    const fs = extractFactors(makeFinancial(), valuation, info);
    const z = buildFactorZScores(fs, { roe: [30, 30, 30] });
    expect(z.roe).toBe(0);
  });
});
