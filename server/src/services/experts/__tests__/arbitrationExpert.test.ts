/**
 * 数据仲裁官（arbitrationExpert）单测
 * ----------------------------------------------------------------------------
 * 两条主路径：
 *  1) LLM 不可用 / LLM 抛错 / LLM 返回结构非法 → 规则引擎（arbitrationExpertRule）：
 *     覆盖估值分位、增长、现金流质量、杠杆、行业趋势、共识与分歧主题、
 *     基本面档位、定位建议、论点切片等分支。
 *  2) LLM 可用 → normalizeArbitration 的字段裁剪、clamp、枚举回退、切片与默认值。
 *
 * 全程不打真实网络：llm/index.js（isLLMAvailable / chatJSON）与 llm/prompts.js（formatContext）
 * 均为完整替身；safeDiv 用真实实现（纯函数）。
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
vi.mock('../../../llm/prompts.js', () => ({ formatContext: promptsMock.formatContext }));

import { arbitrationExpert, type ArbitrationInput } from '../arbitrationExpert.js';

const CTX = 'CTX-600519';

/** 10 档历史 PE（升序），配合 valuation.pe 可精确控制分位 */
const HIST_PE = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((pe, i) => ({
  year: String(2001 + i),
  pe,
}));

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
    ...overrides,
  };
}

function makeValuation(overrides: Partial<ValuationData> = {}): ValuationData {
  return {
    currentPrice: 1800,
    pe: 65, // 10 档历史 PE 中 ≤65 的占 6 档 → 60% 分位（中位区间）
    pb: 6,
    ps: 10,
    marketCap: 22600,
    historicalPE: HIST_PE,
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

function makeOpinion(overrides: Partial<ExpertOpinion> = {}): ExpertOpinion {
  return {
    expert: '基本面专家',
    arguments: [{ text: '毛利率行业领先', confidence: 80, type: 'support', evidenceType: 'fact' }],
    overallSentiment: 'bullish',
    confidence: 80,
    keyPoints: ['护城河稳固'],
    ...overrides,
  };
}

/** 3 位一致看多的专家（共识/分歧主题均为空） */
function bullishOpinions(): ExpertOpinion[] {
  return [
    makeOpinion({ expert: '基本面专家', confidence: 80 }),
    makeOpinion({
      expert: '估值专家',
      confidence: 70,
      keyPoints: ['现金流充裕'],
      arguments: [{ text: '现金流稳健', confidence: 70, type: 'support', evidenceType: 'fact' }],
    }),
    makeOpinion({
      expert: '行业专家',
      confidence: 90,
      keyPoints: ['品牌优势'],
      arguments: [
        { text: '行业景气度上行', confidence: 90, type: 'support', evidenceType: 'fact' },
      ],
    }),
  ];
}

function buildInput(overrides: Partial<ArbitrationInput> = {}): ArbitrationInput {
  return {
    financial: makeFinancial(),
    valuation: makeValuation(),
    info,
    opinions: bullishOpinions(),
    ...overrides,
  };
}

/** 走规则引擎（LLM 不可用） */
async function runRule(overrides: Partial<ArbitrationInput> = {}) {
  llmMock.isLLMAvailable.mockReturnValue(false);
  return arbitrationExpert(buildInput(overrides));
}

function pick<T extends { topic: string }>(items: T[], topic: string): T {
  const found = items.find((c) => c.topic === topic);
  if (!found) throw new Error(`未找到争议点：${topic}`);
  return found;
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

describe('降级路径：LLM 不可用时走规则引擎', () => {
  it('不调用 chatJSON，且返回固定 4 个争议议题', async () => {
    const res = await runRule();
    expect(llmMock.chatJSON).not.toHaveBeenCalled();
    expect(res.controversies.map((c) => c.topic)).toEqual([
      '当前估值水平是否合理',
      '盈利增长可持续性',
      '财务质量与风险',
      '行业周期与政策环境',
    ]);
    for (const c of res.controversies) {
      expect(c.bullishView.length).toBeGreaterThan(0);
      expect(c.bearishView.length).toBeGreaterThan(0);
      expect(c.arbitration.length).toBeGreaterThan(0);
      expect(c.confidence).toBeGreaterThanOrEqual(0);
      expect(c.confidence).toBeLessThanOrEqual(100);
    }
  });

  it('基准多头场景：估值中位分位 + 高增长 + 强现金流 + 低杠杆', async () => {
    const res = await runRule();
    const valuation = pick(res.controversies, '当前估值水平是否合理');
    expect(valuation.bullishView).toBe('PE 65x处于合理区间，估值与基本面匹配度尚可。');
    expect(valuation.bearishView).toBe('白酒同业平均PE仅20.0x，估值中枢可能进一步下移。');
    expect(valuation.arbitration).toBe(
      'PE历史分位60%，估值处于合理区间。结合同业对比看，当前估值高于白酒同业均值20.0x，存在溢价。',
    );
    expect(valuation.confidence).toBe(62); // 60 + |50-60|*0.2

    const growth = pick(res.controversies, '盈利增长可持续性');
    expect(growth.bullishView).toContain('最新净利润增速25.0%');
    expect(growth.bullishView).toContain('6年复合增长率20.1%');
    expect(growth.bearishView).toBe(
      '增速虽为正但低于市场期望，白酒行业整体增速放缓可能限制上行空间。',
    );
    expect(growth.arbitration).toContain('大概率维持中高速水平（最新25.0%，复合20.1%）');
    expect(growth.arbitration).toContain('高毛利率提供利润缓冲');
    expect(growth.confidence).toBe(57); // 55 + |25-20.1|*0.5

    const financial = pick(res.controversies, '财务质量与风险');
    expect(financial.bullishView).toBe(
      '经营现金流/净利润达1.04，毛利率波动仅2.0个百分点，盈利质量高且稳定。',
    );
    expect(financial.bearishView).toBe('财务指标整体中性，需进一步关注白酒行业特有财务风险。');
    expect(financial.arbitration).toBe(
      '贵州茅台现金流充裕，财务结构稳健。现金流/净利润比1.04，毛利率91.0%（波动2.0个百分点），资产负债率19.0%。整体财务质量较好。',
    );
    expect(financial.confidence).toBe(80); // 60 +10(现金流好) +5(毛利稳) +5(低杠杆)

    const industry = pick(res.controversies, '行业周期与政策环境');
    expect(industry.bullishView).toBe(
      '白酒行业竞争格局改善，贵州茅台毛利率提升1.0个百分点，定价能力增强。',
    );
    expect(industry.bearishView).toBe(
      '白酒行业需求放缓，贵州茅台营收增速从22.2%降至18.2%，行业总量增长见顶。',
    );
    expect(industry.arbitration).toContain('白酒行业当前处于景气下行阶段');
    expect(industry.arbitration).toContain('毛利率趋势改善（+1.0个百分点）');
    expect(industry.confidence).toBe(58); // 营收趋势与毛利趋势不一致 → 不加权
  });

  it('最终研判：3 看多 0 中性 0 看空 → bullish，论点合并 support，confidence 取均值', async () => {
    const res = await runRule();
    expect(res.finalOpinion.expert).toBe('数据仲裁官（综合研判）');
    expect(res.finalOpinion.overallSentiment).toBe('bullish');
    expect(res.finalOpinion.confidence).toBe(80); // (80+70+90)/3
    expect(res.finalOpinion.arguments.map((a) => a.text)).toEqual([
      '毛利率行业领先',
      '现金流稳健',
      '行业景气度上行',
    ]);
    expect(res.finalOpinion.arguments.every((a) => a.type === 'support')).toBe(true);
    expect(res.finalOpinion.keyPoints).toEqual([
      '专家共识：各维度均有涉及等方面表现突出',
      '主要分歧：各维度判断较为一致等维度存在判断差异',
      '3位专家看多，0位中性，0位看空',
      '综合判断：基本面优秀，白酒行业周期与估值变化构成主要影响因素',
      '建议定位：贵州茅台优先跟踪，需结合估值分位与行业趋势择机决策',
    ]);
  });

  it('论点合并：support 取前 4 条、oppose 取前 3 条，support 在前', async () => {
    const supports = Array.from({ length: 6 }, (_, i) => ({
      text: `看多理由${i + 1}`,
      confidence: 70,
      type: 'support' as const,
      evidenceType: 'fact' as const,
    }));
    const opposes = Array.from({ length: 5 }, (_, i) => ({
      text: `看空理由${i + 1}`,
      confidence: 60,
      type: 'oppose' as const,
      evidenceType: 'fact' as const,
    }));
    const res = await runRule({
      opinions: [
        makeOpinion({ expert: 'A', arguments: supports }),
        makeOpinion({ expert: 'B', arguments: opposes, overallSentiment: 'bearish' }),
      ],
    });
    expect(res.finalOpinion.arguments.map((a) => a.text)).toEqual([
      '看多理由1',
      '看多理由2',
      '看多理由3',
      '看多理由4',
      '看空理由1',
      '看空理由2',
      '看空理由3',
    ]);
  });
});

describe('规则引擎：估值分位分支', () => {
  it('低分位（20%）+ 无同业数据 → 安全边际文案，不再追加同业对比', async () => {
    const res = await runRule({
      valuation: makeValuation({ pe: 25, peerComparison: [] }),
      opinions: bullishOpinions(),
    });
    const c = pick(res.controversies, '当前估值水平是否合理');
    expect(c.bullishView).toBe('PE 25x处于历史20%分位，估值已充分反映悲观预期，安全边际较高。');
    expect(c.bearishView).toBe('白酒行业估值中枢可能下移，当前未必是底。');
    expect(c.arbitration).toBe('PE历史分位20%，具备一定安全边际。');
    expect(c.confidence).toBe(66); // 60 + |50-20|*0.2
  });

  it('高分位（100%）→ 泡沫风险文案，仲裁偏警示', async () => {
    const res = await runRule({ valuation: makeValuation({ pe: 100 }) });
    const c = pick(res.controversies, '当前估值水平是否合理');
    expect(c.bullishView).toContain('虽处于较高分位，但考虑到白酒行业龙头溢价，估值仍有一定支撑。');
    expect(c.bearishView).toBe('PE 100x处于历史100%分位高位，估值泡沫风险不容忽视。');
    expect(c.arbitration).toContain('PE历史分位100%，估值偏高需注意风险。');
    expect(c.arbitration).toContain('当前估值高于白酒同业均值20.0x，存在溢价。');
    expect(c.confidence).toBe(70); // 60 + |50-100|*0.2
  });

  it('高分位 + 同业 PE 更高 → 仲裁改判为折价', async () => {
    const res = await runRule({
      valuation: makeValuation({
        pe: 100,
        peerComparison: [
          { name: 'A', code: '000001', pe: 130, pb: 5, roe: 20, marketCap: 1000 },
          { name: 'B', code: '000002', pe: 150, pb: 5, roe: 20, marketCap: 1000 },
        ],
      }),
    });
    const c = pick(res.controversies, '当前估值水平是否合理');
    expect(c.arbitration).toContain('当前估值低于白酒同业均值140.0x，存在折价。');
  });

  it('历史 PE 为空 → 分位退化为 50，按中位区间处理', async () => {
    const res = await runRule({
      valuation: makeValuation({ historicalPE: [], peerComparison: [] }),
    });
    const c = pick(res.controversies, '当前估值水平是否合理');
    expect(c.arbitration).toBe('PE历史分位50%，估值处于合理区间。');
    expect(c.confidence).toBe(60);
  });
});

describe('规则引擎：盈利增长分支', () => {
  it('增速 11.5% → 中速；低于复合增速 70% 仍触发弱增长告警', async () => {
    const res = await runRule({
      financial: makeFinancial({ netProfit: [20, 25, 30, 35, 40, 44.6] }),
    });
    const c = pick(res.controversies, '盈利增长可持续性');
    expect(c.bullishView).toContain('保持正增长（最新11.5%），6年复合增长率17.4%');
    // growthWeak 的第二个条件：latestGrowth < avgGrowth * 0.7（11.5 < 12.18）
    expect(c.bearishView).toContain('增速已从17.4%（复合）回落至11.5%');
    expect(c.arbitration).toContain('大概率维持中速水平');
    expect(c.confidence).toBe(58);
  });

  it('增速 12.5%（高于复合增速 70%）→ 仅提示放缓趋势，不算弱增长', async () => {
    const res = await runRule({
      financial: makeFinancial({ netProfit: [20, 25, 30, 35, 40, 45] }),
    });
    const c = pick(res.controversies, '盈利增长可持续性');
    expect(c.bearishView).toBe(
      '增速呈放缓趋势（从复合17.6%降至最新12.5%），白酒行业竞争加剧可能进一步压制增长空间。',
    );
  });

  it('增速 7% → 中低速', async () => {
    const res = await runRule({
      financial: makeFinancial({ netProfit: [20, 25, 30, 35, 40, 42.8] }),
    });
    const c = pick(res.controversies, '盈利增长可持续性');
    expect(c.arbitration).toContain('大概率维持中低速水平');
    expect(c.bearishView).toContain('增速已从');
  });

  it('负增长 -25% → 低速，看多转「短期承压」', async () => {
    const res = await runRule({
      financial: makeFinancial({ netProfit: [20, 25, 30, 35, 40, 30] }),
    });
    const c = pick(res.controversies, '盈利增长可持续性');
    expect(c.bullishView).toBe('贵州茅台虽短期承压，但6年复合增长率8.4%显示中长期增长基础仍在。');
    expect(c.bearishView).toBe(
      '增速已从8.4%（复合）回落至-25.0%，白酒行业需求承压，基数效应加大，维持高增长难度显著上升。',
    );
    expect(c.arbitration).toContain('大概率维持低速水平（最新-25.0%，复合8.4%）');
    expect(c.confidence).toBe(72); // 55 + |−25−8.4|*0.5
  });

  it('零增长（首年亏损使复合增速为 0）→ 文案称「负增长（0.0%）」（照现状断言）', async () => {
    const res = await runRule({
      financial: makeFinancial({ netProfit: [-5, 0, 0, 0, 10, 10] }),
    });
    const c = pick(res.controversies, '盈利增长可持续性');
    expect(c.bullishView).toContain('6年复合增长率0.0%显示中长期增长基础仍在。');
    expect(c.bearishView).toBe('最新净利润出现负增长（0.0%），白酒行业基本面恶化风险需警惕。');
    expect(c.confidence).toBe(55);
  });

  it('上期净利润为 0 → 最新增速退化为 0（分母为零走 0 兜底）', async () => {
    const res = await runRule({
      financial: makeFinancial({ netProfit: [20, 25, 30, 35, 0, 50] }),
    });
    const c = pick(res.controversies, '盈利增长可持续性');
    expect(c.bullishView).toContain('虽短期承压，但6年复合增长率20.1%');
    expect(c.bearishView).toContain('回落至0.0%');
  });
});

describe('规则引擎：财务质量与杠杆分支', () => {
  it('现金流适中（0.6）+ 低负债 → 现金流适中 / 财务结构稳健 / 整体中等', async () => {
    const res = await runRule({
      financial: makeFinancial({ operatingCashFlow: [22, 27, 32, 37, 42, 30] }),
    });
    const c = pick(res.controversies, '财务质量与风险');
    expect(c.bullishView).toBe('毛利率波动仅2.0个百分点，盈利稳定性高，白酒行业竞争格局相对清晰。');
    expect(c.arbitration).toContain('贵州茅台现金流适中，财务结构稳健。');
    expect(c.arbitration).toContain('整体财务质量中等。');
    expect(c.confidence).toBe(75); // 60 +5(适中) +5(毛利稳) +5(低杠杆)
  });

  it('现金流承压（0.4）+ 高杠杆（70%）→ 双重承压文案与「需关注」判定', async () => {
    const res = await runRule({
      financial: makeFinancial({
        operatingCashFlow: [22, 27, 32, 37, 42, 20],
        debtRatio: [60, 62, 64, 66, 68, 70],
      }),
    });
    const c = pick(res.controversies, '财务质量与风险');
    expect(c.bearishView).toBe(
      '经营现金流/净利润仅0.40，资产负债率70.0%偏高，盈利质量和偿债能力双重承压。',
    );
    expect(c.arbitration).toContain('贵州茅台现金流承压，杠杆偏高需关注。');
    expect(c.arbitration).toContain('整体财务质量需关注。');
    expect(c.confidence).toBe(55); // 60 −5 +5 −5
  });

  it('现金流承压 + 杠杆适中 → 只提示盈利含金量', async () => {
    const res = await runRule({
      financial: makeFinancial({
        operatingCashFlow: [22, 27, 32, 37, 42, 20],
        debtRatio: [50, 50, 50, 50, 50, 50],
      }),
    });
    const c = pick(res.controversies, '财务质量与风险');
    expect(c.bearishView).toBe(
      '经营现金流/净利润仅0.40，盈利含金量不足，需关注应收账款和收入确认质量。',
    );
    expect(c.arbitration).toContain('杠杆水平适中。');
  });

  it('现金流良好 + 高杠杆 → 只提示财务杠杆', async () => {
    const res = await runRule({
      financial: makeFinancial({ debtRatio: [60, 64, 66, 68, 69, 70] }),
    });
    const c = pick(res.controversies, '财务质量与风险');
    expect(c.bearishView).toBe(
      '资产负债率70.0%偏高，财务杠杆较大，利率上行或融资收紧时风险敞口增加。',
    );
    expect(c.bullishView).toBe(
      '经营现金流/净利润达1.04，毛利率波动仅2.0个百分点，盈利质量高且稳定。',
    );
  });

  it('毛利率波动大（15 个百分点）→ 稳定性告警，看多退化为现金流论据', async () => {
    const res = await runRule({
      financial: makeFinancial({ grossMargin: [80, 90, 85, 95, 88, 91] }),
    });
    const c = pick(res.controversies, '财务质量与风险');
    expect(c.bullishView).toBe('经营现金流/净利润达1.04，现金回收能力强，盈利真实性高。');
    expect(c.bearishView).toBe(
      '毛利率波动15.0个百分点，盈利稳定性较差，白酒行业竞争格局可能恶化。',
    );
    expect(c.confidence).toBe(70); // 60 +10 −5 +5
  });

  it('现金流与毛利双双不稳 → 看多仅剩 ROE 论据', async () => {
    const res = await runRule({
      financial: makeFinancial({
        grossMargin: [80, 90, 85, 95, 88, 91],
        operatingCashFlow: [22, 27, 32, 37, 42, 20],
        debtRatio: [50, 50, 50, 50, 50, 50],
      }),
    });
    const c = pick(res.controversies, '财务质量与风险');
    expect(c.bullishView).toBe('ROE 26.0%处于白酒行业较好水平，资产运营效率尚可。');
  });

  it('最新净利润为 0 → 现金流/净利润比按 0 处理（分母为零兜底）', async () => {
    const res = await runRule({
      financial: makeFinancial({ netProfit: [20, 25, 30, 35, 40, 0] }),
    });
    const c = pick(res.controversies, '财务质量与风险');
    expect(c.bearishView).toBe(
      '经营现金流/净利润仅0.00，盈利含金量不足，需关注应收账款和收入确认质量。',
    );
    expect(c.arbitration).toContain('贵州茅台现金流承压，财务结构稳健。');
    expect(c.arbitration).toContain('现金流/净利润比0.00');
    expect(c.confidence).toBe(65); // 60 −5(承压) +5(毛利稳) +5(低杠杆)
  });
});

describe('规则引擎：行业周期分支', () => {
  it('营收与毛利同步上行 → 景气回升 + 趋势一致加权', async () => {
    const res = await runRule({
      financial: makeFinancial({
        revenue: [100, 120, 150, 180, 220, 300],
        grossMargin: [90, 91, 92, 91, 90, 95],
      }),
    });
    const c = pick(res.controversies, '行业周期与政策环境');
    expect(c.bullishView).toBe(
      '白酒行业景气度回升，贵州茅台营收增速36.4%（前值22.2%），毛利率同步改善（+5.0个百分点），行业供需格局优化。',
    );
    expect(c.bearishView).toBe(
      '白酒行业面临政策或结构性调整压力，贵州茅台虽暂时稳健但行业β机会减弱。',
    );
    expect(c.arbitration).toContain('白酒行业当前处于景气回升阶段');
    expect(c.confidence).toBe(66); // 58 + 趋势一致 8
  });

  it('营收与毛利同步下行 → 景气下行 + 量价齐跌风险', async () => {
    const res = await runRule({
      financial: makeFinancial({
        revenue: [100, 120, 150, 180, 220, 150],
        grossMargin: [90, 91, 92, 91, 90, 80],
      }),
    });
    const c = pick(res.controversies, '行业周期与政策环境');
    expect(c.bullishView).toContain('行业虽处调整期，但贵州茅台作为龙头仍具韧性');
    expect(c.bearishView).toBe(
      '白酒行业景气度下行，贵州茅台营收增速放缓至-31.8%（前值22.2%），毛利率同步下滑（-10.0个百分点），行业量价齐跌风险。',
    );
    expect(c.arbitration).toContain('毛利率趋势恶化（-10.0个百分点）');
    expect(c.confidence).toBe(66);
  });

  it('仅营收上行（毛利下行）→ 需求回暖文案，趋势不一致不加权', async () => {
    const res = await runRule({
      financial: makeFinancial({
        revenue: [100, 120, 150, 180, 220, 300],
        grossMargin: [90, 91, 92, 91, 90, 80],
      }),
    });
    const c = pick(res.controversies, '行业周期与政策环境');
    expect(c.bullishView).toBe(
      '白酒行业需求回暖，贵州茅台营收增速提升至36.4%，行业集中度提升利好龙头。',
    );
    expect(c.bearishView).toBe(
      '白酒行业竞争加剧，贵州茅台毛利率下滑10.0个百分点，价格战或成本压力显现。',
    );
    expect(c.confidence).toBe(58);
  });

  it('营收与毛利双持平 → 平稳运行 + 竞争格局稳定', async () => {
    const res = await runRule({
      financial: makeFinancial({
        // 营收连续两年同为 +100% 增速（128→256→512，二进制精确值避免浮点误差），毛利率连续两年持平
        revenue: [100, 100, 100, 128, 256, 512],
        grossMargin: [90, 91, 92, 91, 91, 91],
      }),
    });
    const c = pick(res.controversies, '行业周期与政策环境');
    expect(c.arbitration).toContain('白酒行业当前处于平稳运行阶段');
    expect(c.arbitration).toContain('毛利率趋势平稳（+0.0个百分点）');
    expect(c.arbitration).toContain('竞争格局稳定，但需关注宏观政策');
    expect(c.confidence).toBe(66); // 双持平视为趋势一致
  });

  it('负的毛利率变化在仲裁里不带多余正号', async () => {
    const res = await runRule({
      financial: makeFinancial({ grossMargin: [96, 95, 94, 93, 92, 91] }),
    });
    const c = pick(res.controversies, '行业周期与政策环境');
    expect(c.arbitration).toContain('毛利率趋势恶化（-1.0个百分点）');
    expect(c.arbitration).not.toContain('+-');
  });

  it('上上期营收为 0 → 最新营收增速退化为 0（分母为零兜底）', async () => {
    const res = await runRule({
      financial: makeFinancial({ revenue: [100, 120, 150, 180, 0, 260] }),
    });
    const c = pick(res.controversies, '行业周期与政策环境');
    expect(c.bullishView).toBe(
      '白酒行业景气度回升，贵州茅台营收增速0.0%（前值-100.0%），毛利率同步改善（+1.0个百分点），行业供需格局优化。',
    );
  });
});

describe('规则引擎：共识与分歧主题识别', () => {
  it('≥3 位专家提及的关键点算共识，支持/反对并存的维度算分歧', async () => {
    const res = await runRule({
      opinions: [
        makeOpinion({
          expert: '基本面专家',
          keyPoints: ['护城河稳固', '现金流充裕', '品牌溢价'],
          arguments: [
            { text: '估值已反映悲观预期', confidence: 80, type: 'support', evidenceType: 'fact' },
          ],
        }),
        makeOpinion({
          expert: '估值专家',
          keyPoints: ['护城河深厚', '现金流稳健', 'ROE领先'],
          arguments: [
            { text: '行业增速触底', confidence: 70, type: 'support', evidenceType: 'inference' },
          ],
        }),
        makeOpinion({
          expert: '行业专家',
          keyPoints: ['护城河宽阔', '现金流强劲', '毛利率稳定'],
          arguments: [
            { text: '估值偏高', confidence: 65, type: 'oppose', evidenceType: 'inference' },
            { text: '行业竞争加剧', confidence: 60, type: 'oppose', evidenceType: 'inference' },
          ],
        }),
      ],
    });
    expect(res.finalOpinion.keyPoints[0]).toBe('专家共识：护城河、现金流等方面表现突出');
    expect(res.finalOpinion.keyPoints[1]).toBe('主要分歧：估值、行业等维度存在判断差异');
    expect(res.finalOpinion.keyPoints[2]).toBe('3位专家看多，0位中性，0位看空');
  });

  it('同一位专家同时给出支持与反对 → 也计为分歧（照现状断言）', async () => {
    const res = await runRule({
      opinions: [
        makeOpinion({
          expert: '独任专家',
          arguments: [
            { text: '估值便宜', confidence: 80, type: 'support', evidenceType: 'fact' },
            { text: '估值陷阱', confidence: 40, type: 'oppose', evidenceType: 'inference' },
          ],
        }),
      ],
    });
    expect(res.finalOpinion.keyPoints[1]).toBe('主要分歧：估值等维度存在判断差异');
  });
});

describe('规则引擎：基本面档位与定位建议', () => {
  it('ROE 高 + 高毛利 → 优秀；ROE 中 + 中毛利 → 良好', async () => {
    const excellent = await runRule();
    expect(excellent.finalOpinion.keyPoints[3]).toContain('综合判断：基本面优秀');

    const good = await runRule({
      financial: makeFinancial({
        roe: [15, 15, 15, 15, 15, 15],
        grossMargin: [24, 25, 26, 25, 24, 25],
      }),
    });
    expect(good.finalOpinion.keyPoints[3]).toContain('综合判断：基本面良好');
  });

  it('ROE 低 + 低毛利 → 中等；ROE 极低 → 偏弱', async () => {
    const medium = await runRule({
      financial: makeFinancial({
        roe: [8, 8, 8, 8, 8, 8],
        grossMargin: [14, 15, 16, 15, 14, 15],
      }),
    });
    expect(medium.finalOpinion.keyPoints[3]).toContain('综合判断：基本面中等');

    const weak = await runRule({
      financial: makeFinancial({
        roe: [3, 3, 3, 3, 3, 3],
        grossMargin: [14, 15, 16, 15, 14, 15],
      }),
    });
    expect(weak.finalOpinion.keyPoints[3]).toContain('综合判断：基本面偏弱');
  });

  it('毛利低于 30% 时改用成本控制提示', async () => {
    const res = await runRule({
      financial: makeFinancial({ grossMargin: [24, 25, 26, 25, 24, 25] }),
    });
    expect(pick(res.controversies, '盈利增长可持续性').arbitration).toContain(
      '毛利率偏低需关注成本控制',
    );
  });

  it('3 看多 1 看空 → 优先跟踪', async () => {
    const res = await runRule({
      opinions: [
        ...bullishOpinions(),
        makeOpinion({ expert: '风险专家', overallSentiment: 'bearish' }),
      ],
    });
    expect(res.finalOpinion.keyPoints[4]).toContain('贵州茅台优先跟踪');
    expect(res.finalOpinion.keyPoints[2]).toBe('3位专家看多，0位中性，1位看空');
    expect(res.finalOpinion.overallSentiment).toBe('bullish');
  });

  it('2 看多 2 看空 → 持续观察（但情感判定为 bearish）', async () => {
    const res = await runRule({
      opinions: [
        makeOpinion({ expert: 'A' }),
        makeOpinion({ expert: 'B' }),
        makeOpinion({ expert: 'C', overallSentiment: 'bearish' }),
        makeOpinion({ expert: 'D', overallSentiment: 'bearish' }),
      ],
    });
    expect(res.finalOpinion.keyPoints[4]).toContain('贵州茅台持续观察');
    expect(res.finalOpinion.overallSentiment).toBe('bearish');
  });

  it('3 看空 → 建议规避', async () => {
    const res = await runRule({
      opinions: [1, 2, 3].map((i) =>
        makeOpinion({ expert: `E${i}`, overallSentiment: 'bearish', confidence: 60 }),
      ),
    });
    expect(res.finalOpinion.keyPoints[4]).toContain('贵州茅台建议规避');
    expect(res.finalOpinion.overallSentiment).toBe('bearish');
    expect(res.finalOpinion.confidence).toBe(60);
  });

  it('1 看多 2 中性 → 谨慎观望（情感仍按看多数判定）', async () => {
    const res = await runRule({
      opinions: [
        makeOpinion({ expert: 'A' }),
        makeOpinion({ expert: 'B', overallSentiment: 'neutral' }),
        makeOpinion({ expert: 'C', overallSentiment: 'neutral' }),
      ],
    });
    expect(res.finalOpinion.keyPoints[4]).toContain('贵州茅台谨慎观望');
    expect(res.finalOpinion.overallSentiment).toBe('bullish');
    expect(res.finalOpinion.keyPoints[2]).toBe('1位专家看多，2位中性，0位看空');
  });

  it('3 位中性（无看多无看空）→ 情感回退 neutral', async () => {
    const res = await runRule({
      opinions: [1, 2, 3].map((i) =>
        makeOpinion({ expert: `N${i}`, overallSentiment: 'neutral', confidence: 55 }),
      ),
    });
    expect(res.finalOpinion.overallSentiment).toBe('neutral'); // bullish 0 不占多数，neutral 数 ≥2
    expect(res.finalOpinion.keyPoints[2]).toBe('0位专家看多，3位中性，0位看空');
    expect(res.finalOpinion.keyPoints[4]).toContain('贵州茅台谨慎观望');
    expect(res.finalOpinion.confidence).toBe(55);
  });

  it('专家列表为空 → 保守默认：confidence 0、bearish、无论点', async () => {
    const res = await runRule({ opinions: [] });
    expect(res.finalOpinion.confidence).toBe(0);
    expect(res.finalOpinion.overallSentiment).toBe('bearish');
    expect(res.finalOpinion.arguments).toEqual([]);
    expect(res.finalOpinion.keyPoints[2]).toBe('0位专家看多，0位中性，0位看空');
    expect(res.finalOpinion.keyPoints[4]).toContain('贵州茅台谨慎观望');
  });
});

describe('规则引擎：数据长度边界', () => {
  it('只有 1 年数据 → 增速/复合增速退化为 NaN 文案，争议置信度为 NaN（照现状断言）', async () => {
    const res = await runRule({
      financial: makeFinancial({
        years: ['2026'],
        revenue: [100],
        netProfit: [50],
        grossMargin: [90],
        roe: [25],
        operatingCashFlow: [55],
        equity: [500],
        debtRatio: [20],
        accountsReceivable: [5],
        inventory: [10],
        goodwill: [0],
      }),
    });
    const growth = pick(res.controversies, '盈利增长可持续性');
    expect(growth.bullishView).toContain('虽短期承压，但1年复合增长率0.0%');
    expect(growth.arbitration).toContain('（最新NaN%，复合0.0%）');
    expect(Number.isNaN(growth.confidence)).toBe(true);
    const industry = pick(res.controversies, '行业周期与政策环境');
    expect(industry.arbitration).toContain('营收增速NaN%');
    expect(industry.confidence).toBe(66); // 营收/毛利趋势双双缺省为 false，视为一致
  });

  it('0 年数据 → 规则引擎抛 TypeError（照现状断言，疑似缺陷）', async () => {
    await expect(
      runRule({
        financial: makeFinancial({
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
        }),
      }),
    ).rejects.toThrow(TypeError);
  });
});

describe('LLM 路径：结构化结果规范化', () => {
  const fullRaw = {
    controversies: [
      {
        topic: '估值',
        bullishView: '便宜',
        bearishView: '贵',
        arbitration: '中性',
        confidence: 88,
      },
    ],
    finalOpinion: {
      arguments: [
        { text: '现金流强', confidence: 91, type: 'support', evidenceType: 'fact' },
        { text: '负债偏高', confidence: 70, type: 'oppose', evidenceType: 'inference' },
      ],
      overallSentiment: 'bearish',
      confidence: 77,
      keyPoints: ['要点一', '要点二'],
    },
  };

  it('LLM 正常返回 → 原样保留合法字段并使用固定专家名', async () => {
    llmMock.isLLMAvailable.mockReturnValue(true);
    llmMock.chatJSON.mockResolvedValue(fullRaw);
    const res = await arbitrationExpert(buildInput());
    expect(res.controversies).toEqual(fullRaw.controversies);
    expect(res.finalOpinion).toEqual({
      expert: '数据仲裁官（综合研判）',
      arguments: fullRaw.finalOpinion.arguments,
      overallSentiment: 'bearish',
      confidence: 77,
      keyPoints: ['要点一', '要点二'],
    });
  });

  it('争议点：confidence 越界被 clamp、缺失 topic/arbitration 被剔除、最多保留 4 条', async () => {
    llmMock.isLLMAvailable.mockReturnValue(true);
    llmMock.chatJSON.mockResolvedValue({
      controversies: [
        { topic: 'A', arbitration: 'a', confidence: 999 },
        { topic: 'B', arbitration: 'b', confidence: -5 },
        { topic: 'C', arbitration: 'c', confidence: 'not-a-number' },
        { topic: 'D', arbitration: 'd', confidence: 60.6 },
        { topic: '', arbitration: 'e', confidence: 50 },
        { topic: 'F', arbitration: '', confidence: 50 },
        { topic: 'G', arbitration: 'g', confidence: 50 },
      ],
    });
    const res = await arbitrationExpert(buildInput());
    expect(res.controversies.map((c) => [c.topic, c.confidence])).toEqual([
      ['A', 100],
      ['B', 0],
      ['C', 60],
      ['D', 61],
    ]);
    expect(res.controversies[0].bullishView).toBe('');
    expect(res.controversies[0].bearishView).toBe('');
  });

  it('争议点字段非字符串 → String() 强转（数字/布尔/对象都变文本）', async () => {
    llmMock.isLLMAvailable.mockReturnValue(true);
    llmMock.chatJSON.mockResolvedValue({
      controversies: [{ topic: 2026, arbitration: true, bullishView: null, confidence: 50 }],
    });
    const res = await arbitrationExpert(buildInput());
    expect(res.controversies[0]).toEqual({
      topic: '2026',
      bullishView: '',
      bearishView: '',
      arbitration: 'true',
      confidence: 50,
    });
  });

  it('controversies 非数组 → 空数组', async () => {
    llmMock.isLLMAvailable.mockReturnValue(true);
    llmMock.chatJSON.mockResolvedValue({ controversies: 'oops' });
    const res = await arbitrationExpert(buildInput());
    expect(res.controversies).toEqual([]);
  });

  it('finalOpinion 缺失 → confidence/keyPoints 空默认，情感回退 neutral', async () => {
    llmMock.isLLMAvailable.mockReturnValue(true);
    llmMock.chatJSON.mockResolvedValue({});
    const res = await arbitrationExpert(buildInput());
    expect(res.finalOpinion).toEqual({
      expert: '数据仲裁官（综合研判）',
      arguments: [],
      overallSentiment: 'neutral',
      confidence: 60,
      keyPoints: [],
    });
  });

  it('论点：非法 type/evidenceType 回退、空文本剔除、confidence 非法回退 50、最多 8 条', async () => {
    llmMock.isLLMAvailable.mockReturnValue(true);
    const rawArgs = [
      { text: 'a1', confidence: 120, type: 'long', evidenceType: 'guess' },
      { text: 'a2', confidence: 'oops', type: 'oppose', evidenceType: 'hypothesis' },
      { text: 'a3', confidence: null, type: 'support', evidenceType: 'fact' },
      { text: '', confidence: 50, type: 'support', evidenceType: 'fact' },
      { text: 'a5', confidence: 50, type: 'support', evidenceType: 'fact' },
      { text: 'a6', confidence: 50, type: 'support', evidenceType: 'fact' },
      { text: 'a7', confidence: 50, type: 'support', evidenceType: 'fact' },
      { text: 'a8', confidence: 50, type: 'support', evidenceType: 'fact' },
      { text: 'a9', confidence: 50, type: 'support', evidenceType: 'fact' },
      { text: 'a10', confidence: 50, type: 'support', evidenceType: 'fact' },
    ];
    llmMock.chatJSON.mockResolvedValue({ finalOpinion: { arguments: rawArgs } });
    const res = await arbitrationExpert(buildInput());
    expect(res.finalOpinion.arguments).toHaveLength(8);
    expect(res.finalOpinion.arguments[0]).toEqual({
      text: 'a1',
      confidence: 100,
      type: 'support',
      evidenceType: 'inference',
    });
    expect(res.finalOpinion.arguments[1]).toEqual({
      text: 'a2',
      confidence: 50,
      type: 'oppose',
      evidenceType: 'hypothesis',
    });
    // confidence=null 经 Number(null)=0 落在合法区间，不会走 fallback（与 prompts.clampInt 行为不同）
    expect(res.finalOpinion.arguments[2]).toEqual({
      text: 'a3',
      confidence: 0,
      type: 'support',
      evidenceType: 'fact',
    });
    expect(res.finalOpinion.arguments.map((a) => a.text)).toEqual([
      'a1',
      'a2',
      'a3',
      'a5',
      'a6',
      'a7',
      'a8',
      'a9',
    ]);
  });

  it('情感枚举非法 → neutral；confidence 缺失/NaN → 60；keyPoints 过滤空值并截断 6 条', async () => {
    llmMock.isLLMAvailable.mockReturnValue(true);
    llmMock.chatJSON.mockResolvedValue({
      finalOpinion: {
        overallSentiment: 'very-bullish',
        confidence: Number.NaN,
        keyPoints: ['1', '', '2', '3', '4', '5', '6', '7'],
      },
    });
    const res = await arbitrationExpert(buildInput());
    expect(res.finalOpinion.overallSentiment).toBe('neutral');
    expect(res.finalOpinion.confidence).toBe(60);
    expect(res.finalOpinion.keyPoints).toEqual(['1', '2', '3', '4', '5', '6']);
  });

  it('keyPoints 非数组 → 空数组；数值型要点被转成字符串', async () => {
    llmMock.isLLMAvailable.mockReturnValue(true);
    llmMock.chatJSON.mockResolvedValueOnce({ finalOpinion: { keyPoints: 'oops' } });
    expect((await arbitrationExpert(buildInput())).finalOpinion.keyPoints).toEqual([]);

    llmMock.chatJSON.mockResolvedValueOnce({ finalOpinion: { keyPoints: [0, 1] } });
    expect((await arbitrationExpert(buildInput())).finalOpinion.keyPoints).toEqual(['0', '1']);
  });
});

describe('LLM 路径：提示词装配与调用参数', () => {
  const opinion: ExpertOpinion = {
    expert: '基本面专家',
    arguments: [
      { text: '毛利率高', confidence: 80, type: 'support', evidenceType: 'fact' },
      { text: '增速放缓', confidence: 40, type: 'oppose', evidenceType: 'inference' },
    ],
    overallSentiment: 'bullish',
    confidence: 80,
    keyPoints: ['护城河', '现金流'],
  };

  beforeEach(() => {
    llmMock.isLLMAvailable.mockReturnValue(true);
    llmMock.chatJSON.mockResolvedValue({});
  });

  it('system/user 两条消息：上下文 + 专家意见摘要 + JSON schema', async () => {
    await arbitrationExpert(buildInput({ opinions: [opinion] }));
    const messages = llmMock.chatJSON.mock.calls[0][0] as { role: string; content: string }[];
    expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(messages[0].content).toContain('你是数据仲裁官');
    expect(messages[1].content.startsWith(`${CTX}\n\n=== 各专家研判意见 ===`)).toBe(true);
    expect(messages[1].content).toContain('【基本面专家】情绪:bullish 置信:80');
    expect(messages[1].content).toContain(
      '论点: [support]毛利率高(置信80); [oppose]增速放缓(置信40)',
    );
    expect(messages[1].content).toContain('要点: 护城河；现金流');
    expect(messages[1].content).toContain('"controversies"');
    expect(promptsMock.formatContext).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it('调用参数：temperature 0.4 / maxTokens 2500 / timeout 60000', async () => {
    await arbitrationExpert(buildInput());
    expect(llmMock.chatJSON).toHaveBeenCalledWith(expect.anything(), {
      temperature: 0.4,
      maxTokens: 2500,
      timeout: 60000,
    });
  });

  it('ratingAccuracy 有值时追加事后校准块，无值/空串时不追加', async () => {
    await arbitrationExpert(buildInput({ ratingAccuracy: '样本 12 次，命中率 58%' }));
    const withBlock = llmMock.chatJSON.mock.calls[0][0] as { content: string }[];
    expect(withBlock[1].content).toContain(
      '=== 历史评级事后校准（决策-结果闭环）===\n样本 12 次，命中率 58%',
    );

    llmMock.chatJSON.mockClear();
    await arbitrationExpert(buildInput({ ratingAccuracy: '' }));
    const emptyBlock = llmMock.chatJSON.mock.calls[0][0] as { content: string }[];
    expect(emptyBlock[1].content).not.toContain('历史评级事后校准');

    llmMock.chatJSON.mockClear();
    await arbitrationExpert(buildInput());
    const noneBlock = llmMock.chatJSON.mock.calls[0][0] as { content: string }[];
    expect(noneBlock[1].content).not.toContain('历史评级事后校准');
  });

  it('无专家意见时摘要为空也不报错', async () => {
    const res = await arbitrationExpert(buildInput({ opinions: [] }));
    expect(res.controversies).toEqual([]);
    const messages = llmMock.chatJSON.mock.calls[0][0] as { content: string }[];
    expect(messages[1].content).toContain('=== 各专家研判意见 ===\n\n');
  });
});

describe('LLM 路径：失败与非法结构一律降级规则引擎', () => {
  beforeEach(() => {
    llmMock.isLLMAvailable.mockReturnValue(true);
  });

  it('chatJSON 抛错 → 记 warn 并返回规则引擎结果（带降级标记）', async () => {
    llmMock.chatJSON.mockRejectedValue(new Error('LLM timeout'));
    const res = await arbitrationExpert(buildInput());
    expect(res.controversies).toHaveLength(4);
    expect(res.finalOpinion.keyPoints[0]).toContain('专家共识');
    expect(warnSpy).toHaveBeenCalledWith('[LLM] 仲裁专家降级规则引擎', {
      err: expect.any(Error),
      reason: 'llm_error',
    });
    // 降级必须可被上层看见，否则报告会把规则引擎结论当成 LLM 仲裁呈现
    expect(res.finalOpinion._degraded).toBe(true);
    expect(res.finalOpinion._degradeReason).toBe('llm_error');
  });

  it('LLM 返回数组里含 null → 规范化抛错被捕获 → 同样降级', async () => {
    llmMock.chatJSON.mockResolvedValue({ controversies: [null] });
    const res = await arbitrationExpert(buildInput());
    expect(res.controversies).toHaveLength(4);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('LLM 返回的 finalOpinion.arguments 含 null → 同样降级', async () => {
    llmMock.chatJSON.mockResolvedValue({ finalOpinion: { arguments: [null] } });
    const res = await arbitrationExpert(buildInput());
    expect(res.controversies.map((c) => c.topic)).toEqual([
      '当前估值水平是否合理',
      '盈利增长可持续性',
      '财务质量与风险',
      '行业周期与政策环境',
    ]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
