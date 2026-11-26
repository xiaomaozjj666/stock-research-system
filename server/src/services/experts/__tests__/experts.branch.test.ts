/**
 * 行业/资金专家的规则引擎分支覆盖
 * ----------------------------------------------------------------------------
 * 这两个专家的降级规则里有大量阈值分桶（增速 >15/10/5/0、趋势 ±5、毛利率 ±3、
 * 市值 2000/10000、现金流 0.3/0.9…）。此前只覆盖了"健康公司"一侧，
 * 这里用少量场景把每个桶的两侧都走一遍，防止改阈值时静默改变结论。
 *
 * LLM 一律不可用（规则引擎路径），formatContext 打桩，不触网。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FinancialData, StockInfo, ValuationData } from '../../../types.js';

const llmMock = vi.hoisted(() => ({ isLLMAvailable: vi.fn(), chatJSON: vi.fn() }));
vi.mock('../../../llm/index.js', () => ({
  isLLMAvailable: llmMock.isLLMAvailable,
  chatJSON: llmMock.chatJSON,
}));
vi.mock('../../../llm/prompts.js', () => ({ formatContext: () => 'CTX' }));

import { capitalFlowExpert } from '../capitalFlowExpert.js';
import { industryExpert } from '../industryExpert.js';
import { valuationExpert } from '../valuationExpert.js';

function makeFinancial(over: Partial<FinancialData> = {}): FinancialData {
  return {
    years: ['2021', '2022', '2023', '2024', '2025'],
    revenue: [100, 100, 100, 100, 100],
    netProfit: [20, 20, 20, 20, 20],
    grossMargin: [50, 50, 50, 50, 50],
    netMargin: [20, 20, 20, 20, 20],
    roe: [20, 20, 20, 20, 20],
    operatingCashFlow: [20, 20, 20, 20, 20],
    eps: [1, 1, 1, 1, 1],
    totalAssets: [500, 500, 500, 500, 500],
    totalLiabilities: [200, 200, 200, 200, 200],
    equity: [300, 300, 300, 300, 300],
    accountsReceivable: [10, 10, 10, 10, 10],
    inventory: [10, 10, 10, 10, 10],
    goodwill: [0, 0, 0, 0, 0],
    debtRatio: [40, 40, 40, 40, 40],
    ...over,
  };
}

function makeValuation(over: Partial<ValuationData> = {}): ValuationData {
  return {
    currentPrice: 20,
    pe: 20,
    pb: 2,
    ps: 3,
    marketCap: 3000,
    historicalPE: [{ year: '2025', pe: 20, isEstimated: false }],
    peerComparison: [],
    ...over,
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

const text = (op: { arguments: { text: string }[] }) => op.arguments.map((a) => a.text);

beforeEach(() => {
  llmMock.isLLMAvailable.mockReset().mockReturnValue(false);
});

describe('industryExpert 规则引擎分桶', () => {
  it('高增速 >15 + 趋势 >5 + 毛利率上行 + 高集中度 + ROE 领先 → bullish/19 分', async () => {
    const fin = makeFinancial({
      revenue: [100, 120, 150, 190, 250],
      grossMargin: [40, 41, 42, 43, 45],
      roe: [30, 31, 32, 33, 34],
    });
    const val = makeValuation({
      marketCap: 10000,
      pe: 20,
      peerComparison: [{ name: 'P', code: '000001', pe: 10, pb: 2, roe: 10, marketCap: 2000 }],
    });
    const op = await industryExpert(fin, val, info);
    expect(op.industryScoreSuggestion).toBe(19);
    expect(op.overallSentiment).toBe('bullish');
    expect(text(op)).toContain('行业平均营收增速25.8%，处于高速成长期');
    expect(text(op).join('\n')).toContain('龙头格局清晰');
    expect(text(op).join('\n')).toContain('显著领先同业');
  });

  it('收缩 + 毛利率下行 + 低集中度 + ROE 落后 → bearish', async () => {
    const fin = makeFinancial({
      revenue: [100, 98, 96, 94, 92],
      grossMargin: [50, 49, 48, 47, 46],
      roe: [20, 20, 20, 20, 20],
    });
    const val = makeValuation({
      marketCap: 500,
      pe: 5,
      peerComparison: [
        { name: 'P1', code: '000001', pe: 20, pb: 2, roe: 40, marketCap: 4000 },
        { name: 'P2', code: '000002', pe: 20, pb: 2, roe: 40, marketCap: 4000 },
        { name: 'P3', code: '000003', pe: 20, pb: 2, roe: 40, marketCap: 4000 },
      ],
    });
    const op = await industryExpert(fin, val, info);
    expect(op.overallSentiment).toBe('bearish');
    const all = text(op).join('\n');
    expect(all).toContain('行业整体收缩');
    expect(all).toContain('行业集中度较低');
    expect(all).toContain('竞争力不足');
  });

  it('增速 10-15 档 + 毛利率持平 + 无同业 → 14 分', async () => {
    const fin = makeFinancial({
      revenue: [100, 112, 125.4, 140.4, 157.2],
      grossMargin: [50, 50, 50, 50, 50],
    });
    const op = await industryExpert(fin, makeValuation({ peerComparison: [] }), info);
    expect(op.industryScoreSuggestion).toBe(14);
    expect(text(op).join('\n')).toContain('毛利率波动仅0.0个百分点');
  });

  it('增速 5-10 档 + 最新增速高于均值 → 15 分', async () => {
    const fin = makeFinancial({
      revenue: [100, 105, 110.25, 115.76, 133.12],
      grossMargin: [50, 50, 50, 50, 50],
    });
    const op = await industryExpert(fin, makeValuation(), info);
    expect(op.industryScoreSuggestion).toBe(15);
    expect(text(op).join('\n')).toContain('行业景气度回升');
  });

  it('增速 0-5 档 + 最新增速骤降 → 9 分，且集中度落在中档', async () => {
    const fin = makeFinancial({
      revenue: [100, 103, 106.09, 109.27, 103.81],
      grossMargin: [50, 50, 50, 50, 50],
      roe: [20, 20, 20, 20, 20],
    });
    const val = makeValuation({
      marketCap: 1000,
      peerComparison: [
        { name: 'P1', code: '000001', pe: 20, pb: 2, roe: 20, marketCap: 4000 },
        { name: 'P2', code: '000002', pe: 20, pb: 2, roe: 20, marketCap: 4000 },
      ],
    });
    const op = await industryExpert(fin, val, info);
    expect(op.industryScoreSuggestion).toBe(9);
    const all = text(op).join('\n');
    expect(all).toContain('行业景气度下行');
    expect(all).toContain('行业集中度中等');
  });
});

describe('capitalFlowExpert 规则引擎分桶', () => {
  it('高增速 + 龙头市值 + PE 溢价 + 高现金流质量 → bullish', async () => {
    const fin = makeFinancial({
      revenue: [100, 120, 150, 190, 265],
      netProfit: [100, 110, 120, 130, 140],
      operatingCashFlow: [110, 120, 130, 140, 150],
      roe: [20, 20, 20, 20, 20],
    });
    const val = makeValuation({
      marketCap: 20000,
      pe: 30,
      peerComparison: [{ name: 'P', code: '000001', pe: 10, pb: 2, roe: 10, marketCap: 1000 }],
    });
    const op = await capitalFlowExpert(fin, val, info);
    expect(op.overallSentiment).toBe('bullish');
    const all = text(op).join('\n');
    expect(all).toContain('业务持续扩张');
    expect(all).toContain('龙头地位突出');
    expect(all).toContain('资金给予溢价认可');
    expect(all).toContain('流动性充裕');
    expect(all).toContain('筹码锁定性好');
  });

  it('营收收缩 + 小市值 + PE 折价 + 现金流差 → bearish', async () => {
    const fin = makeFinancial({
      years: ['2022', '2023', '2024', '2025'],
      revenue: [100, 90, 81, 56.7],
      netProfit: [100, 100, 100, 100],
      operatingCashFlow: [10, 9, 8, 7],
      roe: [20, 20, 20, 20],
    });
    const val = makeValuation({
      marketCap: 1000,
      pe: 5,
      peerComparison: [{ name: 'P', code: '000001', pe: 20, pb: 2, roe: 10, marketCap: 9000 }],
    });
    const op = await capitalFlowExpert(fin, val, info);
    expect(op.overallSentiment).toBe('bearish');
    const all = text(op).join('\n');
    expect(all).toContain('业务收缩');
    expect(all).toContain('显著低于均值');
    expect(all).toContain('体量偏小');
    expect(all).toContain('估值折价');
    expect(all).toContain('小盘股流动性偏弱');
    expect(all).toContain('盈利含金量不足');
  });

  it('温和增长 + 中盘/中现金流/中估值 → neutral 分支全部命中', async () => {
    const fin = makeFinancial({
      years: ['2022', '2023', '2024', '2025'],
      revenue: [100, 105, 110, 115.5],
      netProfit: [100, 100, 100, 100],
      operatingCashFlow: [60, 60, 60, 60],
      roe: [10, 20, 10, 20],
    });
    const val = makeValuation({
      marketCap: 3000,
      pe: 15,
      peerComparison: [
        { name: 'P1', code: '000001', pe: 20, pb: 2, roe: 10, marketCap: 3000 },
        { name: 'P2', code: '000002', pe: 20, pb: 2, roe: 10, marketCap: 3000 },
      ],
    });
    const op = await capitalFlowExpert(fin, val, info);
    expect(op.overallSentiment).toBe('neutral');
    const all = text(op).join('\n');
    expect(all).toContain('业务温和扩张');
    expect(all).toContain('中盘股流动性适中');
    expect(all).toContain('筹码稳定性一般');
  });
});

describe('valuationExpert 规则引擎分桶', () => {
  const other = { ...info, code: '000001', name: '平安银行' };

  it('真实分位 <30 + PEG<1 + PB 折价 → bullish', async () => {
    const fin = makeFinancial({
      netProfit: [10, 10, 10, 10, 12],
      operatingCashFlow: [100, 100, 100, 100, 100],
      eps: [1, 1, 1, 1, 1],
    });
    const val = makeValuation({
      pe: 10,
      pb: 2,
      currentPrice: 20,
      marketCap: 200,
      historicalPE: [
        { year: '2022', pe: 20 },
        { year: '2023', pe: 25 },
        { year: '2024', pe: 30 },
      ],
      peerComparison: [{ name: 'P', code: '000002', pe: 30, pb: 4, roe: 10, marketCap: 1000 }],
    });
    const op = await valuationExpert(fin, val, other);
    expect(op.overallSentiment).toBe('bullish');
    const all = text(op).join('\n');
    expect(all).toContain('PEG约0.50');
    expect(all).toContain('DCF估算每股价值');
    expect(all).toContain('股息率约1.5%');
    expect(all).toContain('PE折价、PB折价');
    expect(all).toContain('增速加快');
  });

  it('真实分位 >70 + PEG>1.5 + 同业溢价 → bearish', async () => {
    const fin = makeFinancial({
      netProfit: [10, 10, 10, 20, 25],
      operatingCashFlow: [10, 10, 10, 10, 10],
      eps: [0.1, 0.1, 0.1, 0.1, 0.1],
    });
    const val = makeValuation({
      pe: 40,
      pb: 8,
      currentPrice: 20,
      marketCap: 200,
      historicalPE: [
        { year: '2022', pe: 10 },
        { year: '2023', pe: 12 },
        { year: '2024', pe: 15 },
        { year: '2025', pe: 18 },
      ],
      peerComparison: [{ name: 'P', code: '000002', pe: 20, pb: 2, roe: 10, marketCap: 1000 }],
    });
    const op = await valuationExpert(fin, val, other);
    expect(op.overallSentiment).toBe('bearish');
    const all = text(op).join('\n');
    expect(all).toContain('PEG约1.60');
    expect(all).toContain('PE溢价、PB溢价');
    expect(all).toContain('增速放缓');
  });

  it('只有估算历史 PE + 无增速/无市值/无同业 → neutral 且置信度封顶 40', async () => {
    const fin = makeFinancial({
      netProfit: [10, 10, 10, 10, 0],
      eps: [0, 0, 0, 0, 0],
    });
    const val = makeValuation({
      pe: 15,
      marketCap: 0,
      currentPrice: 0,
      historicalPE: [{ year: '2025', pe: 15, isEstimated: true }],
      peerComparison: [],
    });
    const op = await valuationExpert(fin, val, other);
    expect(op.overallSentiment).toBe('neutral');
    expect(op.confidence).toBeLessThanOrEqual(40);
    const all = text(op).join('\n');
    expect(all).toContain('不参与分位与评级');
    expect(all).toContain('无法计算有经济含义的PEG');
    expect(all).toContain('DCF无法形成有效每股价值');
    expect(all).toContain('无法判断');
  });

  it('真实分位居中 + PEG 1~1.5 + 显式 capEx → neutral', async () => {
    const fin = makeFinancial({
      netProfit: [10, 10, 10, 10, 11.5],
      operatingCashFlow: [50, 50, 50, 50, 60],
      eps: [2, 2, 2, 2, 2],
      capEx: [1, 1, 1, 1, 1],
    });
    const val = makeValuation({
      pe: 20,
      pb: 3,
      currentPrice: 20,
      marketCap: 200,
      historicalPE: [
        { year: '2022', pe: 10 },
        { year: '2023', pe: 20 },
        { year: '2024', pe: 30 },
        { year: '2025', pe: 40 },
      ],
      peerComparison: [{ name: 'P', code: '000002', pe: 22, pb: 2.5, roe: 10, marketCap: 1000 }],
    });
    const op = await valuationExpert(fin, val, other);
    expect(op.overallSentiment).toBe('neutral');
    const all = text(op).join('\n');
    expect(all).toContain('PEG约1.33');
    expect(all).toContain('未处于历史极端区间');
    expect(all).toContain('股息率约3.0%');
  });

  it('单年数据：PEG/增速趋势均跳过，但 DCF/股息仍按可用输入计算', async () => {
    const fin = makeFinancial({
      years: ['2025'],
      revenue: [100],
      netProfit: [10],
      grossMargin: [50],
      netMargin: [20],
      roe: [20],
      operatingCashFlow: [50],
      eps: [2],
      totalAssets: [500],
      totalLiabilities: [200],
      equity: [300],
      accountsReceivable: [10],
      inventory: [10],
      goodwill: [0],
      debtRatio: [40],
    });
    const val = makeValuation({
      pe: 15,
      pb: 2,
      currentPrice: 20,
      marketCap: 200,
      historicalPE: [
        { year: '2024', pe: 10 },
        { year: '2025', pe: 20 },
      ],
      peerComparison: [{ name: 'P', code: '000002', pe: 20, pb: 2, roe: 10, marketCap: 1000 }],
    });
    const op = await valuationExpert(fin, val, other);
    const all = text(op).join('\n');
    expect(all).toContain('DCF估算每股价值');
    expect(all).not.toContain('利润增速由');
    expect(all).not.toContain('PEG约');
  });
});
