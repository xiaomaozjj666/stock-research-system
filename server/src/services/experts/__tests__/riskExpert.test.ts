/**
 * 风险合规专家（riskExpert）单测
 * ----------------------------------------------------------------------------
 * 覆盖：
 *  1) LLM 不可用 → 规则引擎（riskExpertRule）：应收账款/存货/现金流/商誉/负债率
 *     五类信号的正负分支与全部阈值边界（0.3 / 0.5 / 0.9、20% / 50% / 80%、
 *     应收增速 +30 个百分点、存货绝对 20% 门槛），综合风险等级与置信度计算。
 *  2) LLM 可用 → 走真实 runExpertWithLLM + 真实 normalizeExpertOpinion：
 *     消息装配（system/user）、调用参数、额外语境透传、结构规范化。
 *  3) LLM 抛错 → 记 warn 且降级结果与规则路径完全一致。
 *
 * 全程不打真实网络：llm/index.js（isLLMAvailable / chatJSON）为完整替身，
 * prompts.js 仅替换 formatContext（保留真实 normalizeExpertOpinion / schema）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FinancialData, ValuationData, StockInfo, ExpertOpinion } from '../../../types.js';
import logger from '../../../utils/logger.js';

const llmMock = vi.hoisted(() => ({ isLLMAvailable: vi.fn(), chatJSON: vi.fn() }));
const promptsMock = vi.hoisted(() => ({ formatContext: vi.fn() }));

vi.mock('../../../llm/index.js', () => ({
  isLLMAvailable: llmMock.isLLMAvailable,
  chatJSON: llmMock.chatJSON,
}));
vi.mock('../../../llm/prompts.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../llm/prompts.js')>();
  return { ...actual, formatContext: promptsMock.formatContext };
});

import { riskExpert } from '../riskExpert.js';
import { EXPERT_OUTPUT_SCHEMA } from '../../../llm/prompts.js';

const CTX = 'CTX-600519';
const EXPERT_NAME = '风险合规专家';

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
    accountsReceivable: [3, 3.5, 4, 4.5, 4.8, 5],
    inventory: [20, 20, 20, 20, 20, 18],
    goodwill: [0, 0, 0, 0, 0, 0],
    debtRatio: [20, 20, 20, 20, 20, 19],
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

/** 走规则引擎（LLM 不可用） */
function runRule(
  financial: FinancialData = makeFinancial(),
  valuation: ValuationData = makeValuation(),
): Promise<ExpertOpinion> {
  llmMock.isLLMAvailable.mockReturnValue(false);
  return riskExpert(financial, valuation, info);
}

/** 把论点压成 [type, confidence, text] 便于整体断言 */
function argRows(op: ExpertOpinion): [string, number, string][] {
  return op.arguments.map((a) => [a.type, a.confidence, a.text]);
}

function texts(op: ExpertOpinion): string[] {
  return op.arguments.map((a) => a.text);
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  llmMock.isLLMAvailable.mockReset().mockReturnValue(false);
  llmMock.chatJSON.mockReset();
  promptsMock.formatContext.mockReset().mockReturnValue(CTX);
  warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('规则引擎：健康公司（多正面信号）', () => {
  it('应收占比低 + 库存去化 + 强现金流 + 零商誉 + 低负债 → bullish', async () => {
    const op = await runRule();
    expect(op.expert).toBe(EXPERT_NAME);
    expect(op.overallSentiment).toBe('bullish');
    expect(op.confidence).toBe(77); // (80+72+78+75+78)/5
    expect(argRows(op)).toEqual([
      ['support', 80, '应收账款占营收仅1.9%，坏账风险极低'],
      ['support', 72, '存货同比下降10.0%而营收增长，库存去化健康'],
      ['support', 78, '经营现金流/净利润均值1.07，利润含金量高'],
      ['support', 75, '零商誉，无减值风险'],
      ['support', 78, '资产负债率19.0%，财务安全垫厚实'],
    ]);
    expect(op.keyPoints).toEqual([
      '应收占营收1.9%，回款能力极强',
      '零商誉，无减值风险',
      '低负债率19%，财务稳健',
    ]);
  });
});

describe('规则引擎：应收账款信号', () => {
  it('应收增速远超营收增速（+30 个百分点且 >20%）→ oppose 82 + 要点', async () => {
    const op = await runRule(
      makeFinancial({
        accountsReceivable: [50, 50, 50, 50, 50, 100],
        revenue: [100, 100, 100, 100, 100, 110],
      }),
    );
    expect(texts(op)).toContain('应收账款增速100.0%远超营收增速10.0%，存在虚增收入或回款恶化风险');
    expect(op.arguments[0].confidence).toBe(82);
    expect(op.arguments[0].evidenceType).toBe('fact');
    expect(op.keyPoints).toContain('应收增速100%远超营收10%，回款异常');
  });

  it('应收占比恰好 20% 边界：既不触发「占比过高」也不触发「极低」', async () => {
    const op = await runRule(
      // arGrowth=30%（未超营收增速+30），arRatio=52/260=20.0%（不大于 20）
      makeFinancial({
        accountsReceivable: [30, 30, 30, 30, 40, 52],
        inventory: [20, 20, 20, 20, 20, 20],
      }),
    );
    expect(texts(op).some((t) => t.includes('应收账款'))).toBe(false);
  });

  it('应收占比 >20% → oppose 75（信用风险敞口）', async () => {
    const op = await runRule(makeFinancial({ accountsReceivable: [60, 60, 60, 60, 60, 64] }));
    expect(texts(op)).toContain('应收账款占营收24.6%，信用风险敞口较大');
    expect(op.arguments[0].confidence).toBe(75);
    expect(op.keyPoints).toContain('应收占营收24.6%，回款风险偏高');
  });

  it('应收增速恰好等于营收增速 +30 个百分点 → 不触发（严格大于）', async () => {
    const op = await runRule(
      makeFinancial({
        accountsReceivable: [100, 100, 100, 100, 100, 150],
        revenue: [100, 100, 100, 100, 100, 120],
      }),
    );
    expect(texts(op)).toContain('应收账款占营收125.0%，信用风险敞口较大');
    expect(texts(op).some((t) => t.includes('远超营收增速'))).toBe(false);
  });

  it('应收上年基数为 0 → 增速兜底为 0，只按占比判断（照现状断言）', async () => {
    const op = await runRule(makeFinancial({ accountsReceivable: [0, 0, 0, 0, 0, 100] }));
    expect(texts(op).some((t) => t.includes('应收账款增速'))).toBe(false);
    expect(texts(op)).toContain('应收账款占营收38.5%，信用风险敞口较大');
  });

  it('只有 1 年数据 → 应收增速按 0 处理，仅比较占比', async () => {
    const op = await runRule(
      makeFinancial({
        years: ['2026'],
        revenue: [100],
        netProfit: [10],
        operatingCashFlow: [12],
        accountsReceivable: [5],
        inventory: [20],
        goodwill: [0],
        equity: [100],
        debtRatio: [20],
      }),
    );
    expect(texts(op).some((t) => t.includes('应收'))).toBe(false);
    expect(op.arguments).toHaveLength(3); // 现金流 + 零商誉 + 低负债
    expect(op.overallSentiment).toBe('bullish');
    expect(op.confidence).toBe(77); // (78+75+78)/3
  });
});

describe('规则引擎：存货信号', () => {
  it('存货增速远超营收 → oppose 78 + 要点', async () => {
    const op = await runRule(makeFinancial({ inventory: [10, 10, 10, 10, 10, 20] }));
    expect(texts(op)).toContain('存货增速100.0%远超营收增速18.2%，存在积压或减值风险');
    expect(op.arguments.find((a) => a.text.includes('存货增速'))?.confidence).toBe(78);
    expect(op.keyPoints).toContain('存货增速100%远超营收，积压风险');
  });

  it('存货增长 15% 但营收下滑 20% → 因绝对 20% 门槛不告警（照现状断言）', async () => {
    const op = await runRule(
      makeFinancial({
        inventory: [10, 10, 10, 10, 10, 11.5],
        revenue: [100, 120, 150, 180, 220, 176],
      }),
    );
    expect(texts(op).some((t) => t.includes('存货'))).toBe(false);
  });

  it('存货增速恰好 20% → 不触发（严格大于）', async () => {
    const op = await runRule(
      makeFinancial({
        inventory: [10, 10, 10, 10, 10, 12],
        revenue: [100, 120, 150, 180, 220, 260],
      }),
    );
    expect(texts(op).some((t) => t.includes('存货'))).toBe(false);
  });

  it('存货下降而营收增长 → support 72（无要点）', async () => {
    const op = await runRule(makeFinancial({ inventory: [20, 20, 20, 20, 20, 15] }));
    expect(texts(op)).toContain('存货同比下降25.0%而营收增长，库存去化健康');
    expect(op.keyPoints).not.toContain('存货同比下降25.0%而营收增长，库存去化健康');
  });
});

describe('规则引擎：现金流与利润背离', () => {
  it('均值恰好 0.3 / 0.5 / 0.9 → 三个阈值都不触发（严格比较）', async () => {
    const zeros = [10, 10, 10, 10, 10, 10];
    const at03 = await runRule(
      makeFinancial({ operatingCashFlow: [3, 3, 3, 3, 3, 3], netProfit: zeros }),
    );
    expect(texts(at03).some((t) => t.includes('现金流'))).toBe(false);

    const at05 = await runRule(
      makeFinancial({ operatingCashFlow: [5, 5, 5, 5, 5, 5], netProfit: zeros }),
    );
    expect(texts(at05).some((t) => t.includes('现金流'))).toBe(false);

    const at09 = await runRule(
      makeFinancial({ operatingCashFlow: [9, 9, 9, 9, 9, 9], netProfit: zeros }),
    );
    expect(texts(at09).some((t) => t.includes('现金流'))).toBe(false);
  });

  it('均值 <0.3 → oppose 85 且标记致命风险（即便有 4 项正面信号仍 bearish）', async () => {
    const op = await runRule(
      makeFinancial({ operatingCashFlow: [1, 1, 1, 1, 1, 1], netProfit: [10, 10, 10, 10, 10, 10] }),
    );
    expect(texts(op)).toContain('经营现金流/净利润均值仅0.10，利润含金量严重不足');
    expect(op.arguments.find((a) => a.text.includes('利润含金量严重不足'))?.confidence).toBe(85);
    expect(op.keyPoints).toContain('现金流/净利润0.10，利润含金量差');
    expect(op.overallSentiment).toBe('bearish');
    expect(op.confidence).toBe(78); // (80+72+85+75+78)/5
  });

  it('最新年度转负但均值仍 >0.5 → oppose 78 推断型，且不算致命风险', async () => {
    const op = await runRule(
      makeFinancial({
        operatingCashFlow: [12, 12, 12, 12, 12, -5],
        netProfit: [10, 10, 10, 10, 10, 10],
      }),
    );
    const row = op.arguments.find((a) => a.text.includes('转负'));
    expect(row).toEqual({
      text: '最新年度现金流/净利润转负（-0.50），盈利质量出现恶化信号',
      confidence: 78,
      type: 'oppose',
      evidenceType: 'inference',
    });
    expect(op.overallSentiment).toBe('bullish'); // 1 反对 + 4 支持
  });

  it('最新年度恰好为 0 且均值 >0.5 → 不触发转负告警', async () => {
    const op = await runRule(
      makeFinancial({
        operatingCashFlow: [12, 12, 12, 12, 12, 0],
        netProfit: [10, 10, 10, 10, 10, 10],
      }),
    );
    expect(texts(op).some((t) => t.includes('转负'))).toBe(false);
  });

  it('净利润为 0 的年份 → safeDiv 兜底 0，均值被拉低', async () => {
    const op = await runRule(
      makeFinancial({
        operatingCashFlow: [20, 20, 20, 20, 20, 20],
        netProfit: [0, 0, 0, 0, 0, 0],
      }),
    );
    expect(texts(op)).toContain('经营现金流/净利润均值仅0.00，利润含金量严重不足');
    expect(op.overallSentiment).toBe('bearish');
  });
});

describe('规则引擎：商誉减值', () => {
  it('商誉/净资产 60% → oppose 88 + 要点 + 致命风险（bearish）', async () => {
    const op = await runRule(
      makeFinancial({
        goodwill: [0, 0, 0, 0, 0, 60],
        equity: [400, 440, 480, 520, 560, 100],
      }),
    );
    expect(texts(op)).toContain('商誉/净资产达60.0%，减值风险极高');
    expect(op.arguments.find((a) => a.text.includes('减值风险极高'))?.confidence).toBe(88);
    expect(op.keyPoints).toContain('商誉/净资产60%，减值风险极高');
    expect(op.overallSentiment).toBe('bearish');
    expect(op.confidence).toBe(79); // (80+72+78+88+78)/5
  });

  it('商誉/净资产恰好 50% → 只算「一定减值风险」（oppose 75）', async () => {
    const op = await runRule(
      makeFinancial({ goodwill: [0, 0, 0, 0, 0, 50], equity: [400, 440, 480, 520, 560, 100] }),
    );
    expect(texts(op)).toContain('商誉/净资产50.0%，存在一定减值风险');
    expect(op.keyPoints.some((k) => k.includes('减值风险极高'))).toBe(false);
    expect(op.overallSentiment).toBe('bullish'); // 1 反对 + 4 支持
  });

  it('商誉/净资产恰好 20% → 三条分支都不命中，不产生论点', async () => {
    const op = await runRule(
      makeFinancial({ goodwill: [0, 0, 0, 0, 0, 20], equity: [400, 440, 480, 520, 560, 100] }),
    );
    expect(texts(op).some((t) => t.includes('商誉'))).toBe(false);
  });
});

describe('规则引擎：负债率信号', () => {
  it('负债率 >80% → oppose 85 + 要点 + 致命风险', async () => {
    const op = await runRule(makeFinancial({ debtRatio: [50, 55, 60, 70, 80, 85] }));
    expect(texts(op)).toContain('资产负债率85.0%，财务风险极高');
    expect(op.arguments.find((a) => a.text.includes('财务风险极高'))?.confidence).toBe(85);
    expect(op.keyPoints).toContain('负债率85%，财务风险极高');
    expect(op.overallSentiment).toBe('bearish');
  });

  it('负债率 >60% 且较首年上升 >5 个百分点 → oppose 78 推断型 + 要点', async () => {
    const op = await runRule(makeFinancial({ debtRatio: [50, 52, 54, 56, 58, 66] }));
    expect(op.arguments.find((a) => a.text.includes('杠杆持续加大'))).toEqual({
      text: '资产负债率66.0%且逐年上升（+16.0个百分点），杠杆持续加大',
      confidence: 78,
      type: 'oppose',
      evidenceType: 'inference',
    });
    expect(op.keyPoints).toContain('负债率上升中，杠杆加大');
  });

  it('负债率恰好 60% → 不触发（严格大于）；恰好 30% → 不算低负债', async () => {
    const at60 = await runRule(makeFinancial({ debtRatio: [40, 45, 50, 55, 58, 60] }));
    expect(texts(at60).some((t) => t.includes('负债率'))).toBe(false);

    const at30 = await runRule(makeFinancial({ debtRatio: [20, 22, 24, 26, 28, 30] }));
    expect(texts(at30).some((t) => t.includes('负债率'))).toBe(false);
  });

  it('趋势按首尾对比：从 90% 降到 66% 视为「未上升」而不告警（照现状断言）', async () => {
    const op = await runRule(makeFinancial({ debtRatio: [90, 40, 40, 40, 40, 66] }));
    expect(texts(op).some((t) => t.includes('杠杆持续加大'))).toBe(false);
  });
});

describe('规则引擎：综合风险等级与置信度', () => {
  it('1 反对 + 4 支持 → bullish', async () => {
    const op = await runRule(
      makeFinancial({
        accountsReceivable: [50, 50, 50, 50, 50, 100],
        revenue: [100, 100, 100, 100, 100, 110],
      }),
    );
    expect(op.arguments.filter((a) => a.type === 'oppose')).toHaveLength(1);
    expect(op.arguments.filter((a) => a.type === 'support')).toHaveLength(4);
    expect(op.overallSentiment).toBe('bullish');
    expect(op.confidence).toBe(77); // (82+72+78+75+78)/5
  });

  it('2 反对 + 3 支持 → neutral', async () => {
    const op = await runRule(
      makeFinancial({
        accountsReceivable: [50, 50, 50, 50, 50, 100], // 应收增速告警（oppose）
        revenue: [100, 100, 100, 100, 100, 110],
        inventory: [10, 10, 10, 10, 10, 20], // 存货积压告警（oppose）
      }),
    );
    expect(op.arguments.filter((a) => a.type === 'oppose')).toHaveLength(2);
    expect(op.arguments.filter((a) => a.type === 'support')).toHaveLength(3);
    expect(op.overallSentiment).toBe('neutral');
  });

  it('3 反对（无致命风险）+ 2 支持 → bearish', async () => {
    const op = await runRule(
      makeFinancial({
        accountsReceivable: [50, 50, 50, 50, 50, 100],
        revenue: [100, 100, 100, 100, 100, 110],
        inventory: [10, 10, 10, 10, 10, 20],
        goodwill: [0, 0, 0, 0, 0, 50], // 商誉 50%：仅「一定减值风险」，不算致命
        equity: [400, 440, 480, 520, 560, 100],
      }),
    );
    expect(op.arguments.filter((a) => a.type === 'oppose')).toHaveLength(3);
    expect(op.arguments.filter((a) => a.type === 'support')).toHaveLength(2); // 现金流 + 低负债
    expect(op.overallSentiment).toBe('bearish');
    expect(op.keyPoints.some((k) => k.includes('减值风险极高'))).toBe(false);
  });

  it('全部指标落在中性区间 → 0 论点、confidence 0、keyPoints 空', async () => {
    const op = await runRule(
      makeFinancial({
        accountsReceivable: [20, 20, 20, 20, 20, 26], // 占比 10%
        inventory: [20, 20, 20, 20, 20, 20], // 零增长
        operatingCashFlow: [9, 9, 9, 9, 9, 9], // 均值 0.9
        netProfit: [10, 10, 10, 10, 10, 10],
        goodwill: [0, 0, 0, 0, 0, 20],
        equity: [400, 440, 480, 520, 560, 200], // 10%
        debtRatio: [50, 50, 50, 50, 50, 50],
      }),
    );
    expect(op.arguments).toEqual([]);
    expect(op.confidence).toBe(0);
    expect(op.overallSentiment).toBe('neutral');
    expect(op.keyPoints).toEqual([]);
  });

  it('空数据（0 年）→ 误报「应收极低 + 零商誉」两项正面信号（照现状断言）', async () => {
    const empty = makeFinancial({
      years: [],
      revenue: [],
      netProfit: [],
      grossMargin: [],
      roe: [],
      operatingCashFlow: [],
      equity: [],
      debtRatio: [],
      accountsReceivable: [],
      inventory: [],
      goodwill: [],
    });
    const op = await runRule(empty);
    expect(argRows(op)).toEqual([
      ['support', 80, '应收账款占营收仅0.0%，坏账风险极低'],
      ['support', 75, '零商誉，无减值风险'],
    ]);
    expect(op.overallSentiment).toBe('neutral');
    expect(op.confidence).toBe(78);
  });
});

describe('LLM 路径：真 runExpertWithLLM + 真 normalizeExpertOpinion', () => {
  const rawBoth: unknown = {
    arguments: [
      { text: '负债率高', confidence: 88, type: 'oppose', evidenceType: 'fact' },
      { text: '现金流好', confidence: 70, type: 'support', evidenceType: 'fact' },
      { text: '', confidence: 70, type: 'support', evidenceType: 'fact' },
      { text: '商誉可控', confidence: 200, type: 'unknown', evidenceType: 'guess' },
    ],
    overallSentiment: 'bearish',
    confidence: 88,
    keyPoints: ['负债率偏高', '现金流稳健'],
  };

  beforeEach(() => {
    llmMock.isLLMAvailable.mockReturnValue(true);
  });

  it('返回规范化后的专家意见（裁剪/回退/剔除空文本）', async () => {
    llmMock.chatJSON.mockResolvedValue(rawBoth);
    const op = await riskExpert(makeFinancial(), makeValuation(), info);
    expect(op).toEqual({
      expert: EXPERT_NAME,
      arguments: [
        { text: '负债率高', confidence: 88, type: 'oppose', evidenceType: 'fact' },
        { text: '现金流好', confidence: 70, type: 'support', evidenceType: 'fact' },
        { text: '商誉可控', confidence: 100, type: 'support', evidenceType: 'inference' },
      ],
      overallSentiment: 'bearish',
      confidence: 88,
      keyPoints: ['负债率偏高', '现金流稳健'],
    });
  });

  it('只有 support 缺少 oppose → 标注 _incomplete（照现状断言）', async () => {
    llmMock.chatJSON.mockResolvedValue({
      arguments: [{ text: '现金流好', confidence: 70, type: 'support', evidenceType: 'fact' }],
      overallSentiment: 'bullish',
      confidence: 70,
      keyPoints: ['现金流稳健'],
    });
    const op = await riskExpert(makeFinancial(), makeValuation(), info);
    expect((op as unknown as { _incomplete?: boolean })._incomplete).toBe(true);
    expect(op.overallSentiment).toBe('bullish');
  });

  it('LLM 返回空对象 → 全部默认值（neutral / 60 / 空论点）', async () => {
    llmMock.chatJSON.mockResolvedValue({});
    const op = await riskExpert(makeFinancial(), makeValuation(), info);
    expect(op.expert).toBe(EXPERT_NAME);
    expect(op.arguments).toEqual([]);
    expect(op.overallSentiment).toBe('neutral');
    expect(op.confidence).toBe(60);
    expect(op.keyPoints).toEqual([]);
  });

  it('消息装配：system 人设 + user（上下文 + 共用输出 schema）', async () => {
    llmMock.chatJSON.mockResolvedValue({});
    await riskExpert(makeFinancial(), makeValuation(), info);
    const messages = llmMock.chatJSON.mock.calls[0][0] as { role: string; content: string }[];
    expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(messages[0].content).toContain('你是资深风险合规分析师');
    expect(messages[0].content).toContain('商誉/净资产超过 30% 即为高风险信号');
    expect(messages[1].content).toBe(`${CTX}\n\n${EXPERT_OUTPUT_SCHEMA}`);
  });

  it('调用参数：temperature 0.4 / maxTokens 1500 / timeout 45000', async () => {
    llmMock.chatJSON.mockResolvedValue({});
    await riskExpert(makeFinancial(), makeValuation(), info);
    expect(llmMock.chatJSON).toHaveBeenCalledWith(expect.anything(), {
      temperature: 0.4,
      maxTokens: 1500,
      timeout: 45000,
    });
  });

  it('extraBrief 透传给 formatContext；省略时为 undefined', async () => {
    llmMock.chatJSON.mockResolvedValue({});
    const financial = makeFinancial();
    const valuation = makeValuation();
    await riskExpert(financial, valuation, info, '一致预期：EPS 上调');
    expect(promptsMock.formatContext).toHaveBeenCalledWith(
      financial,
      valuation,
      info,
      '一致预期：EPS 上调',
    );

    promptsMock.formatContext.mockClear();
    await riskExpert(financial, valuation, info);
    expect(promptsMock.formatContext).toHaveBeenCalledWith(financial, valuation, info, undefined);
  });

  it('isLLMAvailable=false → 不调用 chatJSON，直接规则引擎', async () => {
    llmMock.isLLMAvailable.mockReturnValue(false);
    const op = await riskExpert(makeFinancial(), makeValuation(), info);
    expect(llmMock.chatJSON).not.toHaveBeenCalled();
    expect(op.expert).toBe(EXPERT_NAME);
    expect(op.arguments).toHaveLength(5);
  });
});

describe('LLM 路径：调用失败降级', () => {
  it('chatJSON 抛错 → 记 warn 且结果与规则引擎完全一致', async () => {
    const ruleResult = await runRule();
    llmMock.isLLMAvailable.mockReturnValue(true);
    llmMock.chatJSON.mockRejectedValue(new Error('upstream 500'));
    const fallback = await riskExpert(makeFinancial(), makeValuation(), info);
    expect(fallback).toEqual(ruleResult);
    expect(warnSpy).toHaveBeenCalledWith('[LLM] 降级规则引擎', {
      expertName: EXPERT_NAME,
      err: expect.any(Error),
    });
  });

  it('超时错误同样降级并保留原始错误对象', async () => {
    llmMock.isLLMAvailable.mockReturnValue(true);
    const timeout = new Error('LLM timeout after 45000ms');
    llmMock.chatJSON.mockRejectedValue(timeout);
    await riskExpert(makeFinancial(), makeValuation(), info);
    expect(warnSpy).toHaveBeenCalledWith('[LLM] 降级规则引擎', {
      expertName: EXPERT_NAME,
      err: timeout,
    });
  });
});
