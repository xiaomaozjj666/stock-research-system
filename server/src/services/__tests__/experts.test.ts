import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FinancialData, ValuationData, StockInfo } from '../../types.js';
import { fundamentalExpert } from '../experts/fundamentalExpert.js';
import { valuationExpert } from '../experts/valuationExpert.js';
import { industryExpert, type IndustryExpertResult } from '../experts/industryExpert.js';
import { riskExpert } from '../experts/riskExpert.js';
import { capitalFlowExpert } from '../experts/capitalFlowExpert.js';
import { policyExpert } from '../experts/policyExpert.js';
import { hotMoneyExpert } from '../experts/hotMoneyExpert.js';
import { unlockExpert } from '../experts/unlockExpert.js';

function makeFinancial(overrides: Partial<FinancialData> = {}): FinancialData {
  return {
    years: ['2021', '2022', '2023', '2024', '2025', '2026'],
    revenue: [100, 120, 150, 180, 220, 260],
    netProfit: [20, 25, 30, 35, 40, 50],
    grossMargin: [90, 91, 92, 91, 90, 91],
    netMargin: [20, 21, 20, 19, 18, 19],
    roe: [25, 26, 27, 26, 25, 26],
    operatingCashFlow: [22, 27, 32, 37, 42, 52],
    eps: [1, 1.2, 1.5, 1.7, 2, 2.5],
    totalAssets: [500, 550, 600, 650, 700, 800],
    totalLiabilities: [100, 110, 120, 130, 140, 150],
    equity: [400, 440, 480, 520, 560, 650],
    accountsReceivable: [5, 6, 7, 8, 9, 10],
    inventory: [10, 12, 14, 16, 18, 20],
    goodwill: [0, 0, 0, 0, 0, 0],
    debtRatio: [20, 20, 20, 20, 20, 19],
    dataQuality: { estimatedFields: [], missingFields: ['goodwill'] },
    ...overrides,
  };
}

function makeValuation(overrides: Partial<ValuationData> = {}): ValuationData {
  return {
    currentPrice: 1800,
    pe: 30,
    pb: 6,
    ps: 10,
    marketCap: 22600,
    historicalPE: [{ year: '2026', pe: 30, isEstimated: false }],
    peerComparison: [{ name: '五粮液', code: '000858', pe: 20, pb: 5, roe: 25, marketCap: 5000 }],
    ...overrides,
  };
}

const info: StockInfo = {
  code: '600519',
  name: '贵州茅台',
  industry: '白酒',
  market: '上交所主板',
  listingDate: '',
  description: '',
};

// unlockExpert 用真实当前年份计算上市年限（unlockExpert.ts yearsSinceIPO），
// 用例里的 listingDate 必须是相对年份，否则 2029 年起"不足 1 年"用例必破（年份定时炸弹）
const thisYear = new Date().getFullYear();

/** 验证专家观点结构合法：论点类型/情感/置信度均在枚举内 */
function assertValidOpinion(op: {
  overallSentiment: string;
  confidence: number;
  arguments: Array<{ type: string; confidence: number }>;
}) {
  expect(['bullish', 'neutral', 'bearish']).toContain(op.overallSentiment);
  expect(op.confidence).toBeGreaterThanOrEqual(0);
  expect(op.confidence).toBeLessThanOrEqual(100);
  expect(op.arguments.length).toBeGreaterThan(0);
  for (const a of op.arguments) {
    expect(['support', 'oppose']).toContain(a.type);
    expect(a.confidence).toBeGreaterThanOrEqual(0);
    expect(a.confidence).toBeLessThanOrEqual(100);
  }
}

describe('专家规则引擎（LLM 不可用时的降级路径）', () => {
  beforeEach(() => {
    // 同时清空两个 key：isLLMAvailable() 只要 DEEPSEEK/OPENAI 任一存在就返回 true，
    // 只清 DEEPSEEK 时宿主若有 OPENAI_API_KEY 会走真实 LLM 网络（超时 60s、结果不可控）
    vi.stubEnv('DEEPSEEK_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', '');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('fundamentalExpert 高毛利看多', async () => {
    const op = await fundamentalExpert(makeFinancial(), makeValuation(), info);
    assertValidOpinion(op);
    expect(op.overallSentiment).toBe('bullish');
  });

  it('fundamentalExpert 全面恶化（低毛利/低ROE/弱现金流/高负债/高应收/高商誉）转为看空', async () => {
    const op = await fundamentalExpert(
      makeFinancial({
        grossMargin: [10, 12, 9, 11, 10, 10],
        netMargin: [2, 2, 2, 2, 2, 2],
        roe: [3, 3, 3, 3, 3, 3],
        operatingCashFlow: [5, 5, 5, 5, 5, 5],
        revenue: [260, 250, 240, 200, 180, 150],
        netProfit: [50, 40, 30, 20, 10, 5],
        totalLiabilities: [375, 375, 375, 375, 375, 375],
        equity: [125, 125, 125, 125, 125, 125],
        accountsReceivable: [100, 100, 100, 100, 100, 100],
        inventory: [200, 200, 200, 200, 200, 200],
        goodwill: [60, 60, 60, 60, 60, 60],
        debtRatio: [75, 75, 75, 75, 75, 75],
      }),
      makeValuation(),
      info,
    );
    assertValidOpinion(op);
    expect(op.overallSentiment).toBe('bearish');
  });

  it('valuationExpert 高 PE 偏谨慎', async () => {
    const op = await valuationExpert(makeFinancial(), makeValuation({ pe: 80 }), info);
    assertValidOpinion(op);
  });

  it('industryExpert 返回 0-20 区间的行业景气度评分', async () => {
    const op: IndustryExpertResult = await industryExpert(makeFinancial(), makeValuation(), info);
    assertValidOpinion(op);
    expect(op).toHaveProperty('industryScoreSuggestion');
    // industryScoreSuggestion 为量化评分（数值，0~20），非枚举文案
    expect(typeof op.industryScoreSuggestion).toBe('number');
    expect(op.industryScoreSuggestion).toBeGreaterThanOrEqual(0);
    expect(op.industryScoreSuggestion).toBeLessThanOrEqual(20);
  });

  it('riskExpert 高负债率触发风险预警', async () => {
    const op = await riskExpert(
      makeFinancial({
        debtRatio: [85, 86, 87, 88, 89, 90],
        totalLiabilities: [850, 860, 870, 880, 890, 900],
        equity: [150, 140, 130, 120, 110, 100],
      }),
      makeValuation(),
      info,
    );
    assertValidOpinion(op);
    expect(op.overallSentiment).toBe('bearish');
  });

  it('capitalFlowExpert 始终返回合法结构', async () => {
    const op = await capitalFlowExpert(makeFinancial(), makeValuation(), info);
    assertValidOpinion(op);
  });

  // === P2-12: A 股特色角色 ===

  it('policyExpert 政策支持行业（半导体）→ bullish', async () => {
    const op = await policyExpert(makeFinancial(), makeValuation(), {
      ...info,
      industry: '半导体芯片',
    });
    assertValidOpinion(op);
    expect(op.expert).toBe('政策分析师');
    expect(op.overallSentiment).toBe('bullish');
    expect(op.keyPoints.some((k) => k.includes('政策支持'))).toBe(true);
  });

  it('policyExpert 政策限制行业（房地产）→ bearish', async () => {
    const op = await policyExpert(makeFinancial(), makeValuation(), {
      ...info,
      industry: '房地产开发',
    });
    assertValidOpinion(op);
    expect(op.overallSentiment).toBe('bearish');
    expect(op.keyPoints.some((k) => k.includes('政策限制'))).toBe(true);
  });

  it('policyExpert 中性行业（白酒）→ neutral', async () => {
    const op = await policyExpert(makeFinancial(), makeValuation(), info);
    assertValidOpinion(op);
    expect(op.overallSentiment).toBe('neutral');
  });

  it('hotMoneyExpert 微盘股 + 高 PE → bearish（题材泡沫风险）', async () => {
    const op = await hotMoneyExpert(
      makeFinancial(),
      makeValuation({ marketCap: 30, pe: 80, currentPrice: 5 }),
      info,
    );
    assertValidOpinion(op);
    expect(op.expert).toBe('游资分析师');
    expect(op.overallSentiment).toBe('bearish');
    expect(op.keyPoints.some((k) => k.includes('泡沫') || k.includes('游资'))).toBe(true);
  });

  it('hotMoneyExpert 大盘股 + 低 PE → neutral（机构主导）', async () => {
    const op = await hotMoneyExpert(
      makeFinancial(),
      makeValuation({ marketCap: 5000, pe: 15, currentPrice: 50 }),
      info,
    );
    assertValidOpinion(op);
    expect(op.overallSentiment).toBe('neutral');
    expect(op.keyPoints.some((k) => k.includes('机构') || k.includes('大盘'))).toBe(true);
  });

  it('unlockExpert 上市不足 1 年 → bearish（首次解禁临近）', async () => {
    const op = await unlockExpert(makeFinancial(), makeValuation({ marketCap: 100 }), {
      ...info,
      listingDate: `${thisYear}-01-01`, // 恒为上市不足 1 年（相对年份，避免真实时钟定时炸弹）
    });
    assertValidOpinion(op);
    expect(op.expert).toBe('解禁分析师');
    expect(op.overallSentiment).toBe('bearish');
    expect(op.keyPoints.some((k) => k.includes('解禁'))).toBe(true);
  });

  it('unlockExpert 上市超 5 年 → neutral（解禁压力已释放）', async () => {
    const op = await unlockExpert(makeFinancial(), makeValuation({ marketCap: 5000 }), {
      ...info,
      listingDate: `${thisYear - 20}-01-01`, // 恒为上市超 5 年（mature）
    });
    assertValidOpinion(op);
    expect(op.overallSentiment).toBe('neutral');
    expect(op.keyPoints.some((k) => k.includes('已释放') || k.includes('压力已'))).toBe(true);
  });
});
