import { describe, it, expect } from 'vitest';
import { generateScenarios } from '../scenarioEngine.js';
import type { ExpertOpinion, FinancialData, ValuationData, StockInfo } from '../../types.js';

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

const undervalued: ValuationData = {
  currentPrice: 100,
  pe: 15, // 低于历史中枢 → 低估
  pb: 5,
  ps: 8,
  marketCap: 2000,
  historicalPE: [
    { year: '2021', pe: 30 }, { year: '2022', pe: 28 }, { year: '2023', pe: 26 },
    { year: '2024', pe: 24 }, { year: '2025', pe: 22 }, { year: '2026', pe: 15 },
  ],
  peerComparison: [],
};

const overvalued: ValuationData = {
  currentPrice: 100,
  pe: 60, // 高于历史中枢 → 高估
  pb: 5,
  ps: 8,
  marketCap: 2000,
  historicalPE: [
    { year: '2021', pe: 20 }, { year: '2022', pe: 22 }, { year: '2023', pe: 24 },
    { year: '2024', pe: 26 }, { year: '2025', pe: 28 }, { year: '2026', pe: 60 },
  ],
  peerComparison: [],
};

const info: StockInfo = { code: '600519', name: '测试股', industry: '白酒', market: '上交所主板', listingDate: '', description: '' };

function opinion(sentiment: 'bullish' | 'neutral' | 'bearish'): ExpertOpinion {
  return {
    expert: '测试专家',
    arguments: [{ text: '测试论点', confidence: 80, type: 'support', evidenceType: 'fact' }],
    overallSentiment: sentiment,
    confidence: 80,
    keyPoints: ['测试'],
  };
}

describe('generateScenarios', () => {
  it('返回三情景且名称正确', () => {
    const s = generateScenarios([opinion('bullish')], makeFinancial(), undervalued, info);
    expect(s.map((x) => x.name)).toEqual(['乐观', '中性', '悲观']);
  });

  it('概率均 ∈ [0,1] 且和恰为 1', () => {
    for (const v of [undervalued, overvalued]) {
      const s = generateScenarios([opinion('bullish'), opinion('neutral')], makeFinancial(), v, info);
      const sum = s.reduce((acc, x) => acc + x.probability, 0);
      expect(sum).toBeCloseTo(1, 6);
      for (const x of s) {
        expect(x.probability).toBeGreaterThanOrEqual(0);
        expect(x.probability).toBeLessThanOrEqual(1);
      }
    }
  });

  it('目标价 low ≤ high 且为正', () => {
    const s = generateScenarios([opinion('bullish')], makeFinancial(), undervalued, info);
    for (const x of s) {
      expect(x.targetPriceRange.low).toBeLessThanOrEqual(x.targetPriceRange.high);
      expect(x.targetPriceRange.low).toBeGreaterThanOrEqual(0);
    }
  });

  it('低估优质股：乐观概率 > 悲观概率', () => {
    const s = generateScenarios([opinion('bullish'), opinion('bullish')], makeFinancial(), undervalued, info);
    const opt = s.find((x) => x.name === '乐观')!.probability;
    const pes = s.find((x) => x.name === '悲观')!.probability;
    expect(opt).toBeGreaterThan(pes);
  });

  it('高估股：悲观概率 > 乐观概率', () => {
    const s = generateScenarios([opinion('bearish'), opinion('bearish')], makeFinancial(), overvalued, info);
    const opt = s.find((x) => x.name === '乐观')!.probability;
    const pes = s.find((x) => x.name === '悲观')!.probability;
    expect(pes).toBeGreaterThan(opt);
  });

  it('相同输入产生确定性输出', () => {
    const a = generateScenarios([opinion('neutral')], makeFinancial(), undervalued, info);
    const b = generateScenarios([opinion('neutral')], makeFinancial(), undervalued, info);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
