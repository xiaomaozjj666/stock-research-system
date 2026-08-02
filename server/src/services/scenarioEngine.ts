/**
 * 情景推演引擎（重构版）
 * --------------------------------------------------------------------------
 * 三情景（乐观/中性/悲观）的概率与目标价现在由 predictionModel 的严谨模型驱动：
 *   - 期望收益 E[r] = expectedForwardReturn（因子组合贡献 + PE 均值回复，已夹紧）；
 *   - 情景概率   = scenarioProbabilities（softmax，天然 Σ=1，可选叠加有界的专家情绪微调）；
 *   - 目标价区间 = targetPriceRange（当前价 × (1+E[r]) × (1±band)）。
 * 不再使用原先的 0.4/0.3/0.3 魔法权重与 0.9/1.2 等随意目标价倍数。
 */
import type { ExpertOpinion, FinancialData, ValuationData, StockInfo, NewsSignal } from '../types.js';
import {
  expectedForwardReturnFromData,
  scenarioProbabilities,
  targetPriceRange,
} from './predictionModel.js';

export interface ScenarioResult {
  name: '乐观' | '中性' | '悲观';
  probability: number;
  keyAssumptions: string[];
  targetPriceRange: { low: number; high: number };
  supportingArguments: { expert: string; text: string; confidence: number }[];
  preconditions: string[];
}

/** 将概率（保留2位）归一化到 Σ=1，消除浮点误差累积 */
function normalizeProbabilities(p: {
  optimistic: number;
  neutral: number;
  pessimistic: number;
}): { optimistic: number; neutral: number; pessimistic: number } {
  const o = Math.round(p.optimistic * 100) / 100;
  const n = Math.round(p.neutral * 100) / 100;
  const pe = Math.round(p.pessimistic * 100) / 100;
  const sum = o + n + pe;
  if (sum <= 0) return { optimistic: 1 / 3, neutral: 1 / 3, pessimistic: 1 / 3 };
  return { optimistic: o / sum, neutral: n / sum, pessimistic: pe / sum };
}

export function generateScenarios(
  opinions: ExpertOpinion[],
  financial: FinancialData,
  valuation: ValuationData,
  info: StockInfo,
  news?: { sentimentZ: number; polarity: number },
): ScenarioResult[] {
  const n = financial.years.length;

  // 1. 统计专家情绪分布（作为有界微调，非主导权重）
  const total = opinions.length;
  const bullishCount = opinions.filter((o) => o.overallSentiment === 'bullish').length;
  const bullishRatio = total > 0 ? bullishCount / total : 0.5;
  // 专家情绪微调：限制在 [−0.3, 0.3]，避免掩盖量化模型信号
  const sentimentTilt = Math.max(-0.3, Math.min(0.3, (bullishRatio - 0.5) * 0.6));

  // 2. PE 历史分位
  const peValues = valuation.historicalPE.map((h) => h.pe).sort((a, b) => a - b);
  const pePercentile = peValues.length > 0
    ? (peValues.filter((p) => p <= valuation.pe).length / peValues.length) * 100
    : 50;

  // 3. 严谨期望收益（因子模型 + 估值均值回复，可选叠加最新消息情绪 z）
  const { expectedReturn } = expectedForwardReturnFromData(
    financial,
    valuation,
    info,
    undefined,
    news?.sentimentZ,
  );

  // 4. softmax 情景概率（叠加专家情绪微调 + 最新消息微调）
  const probs = scenarioProbabilities(expectedReturn, pePercentile, sentimentTilt, news?.polarity ?? 0);
  const norm = normalizeProbabilities(probs);

  // 5. 收集支撑/反对论点（置信度阈值，与原逻辑一致）
  const supportArgs = opinions.flatMap((o) =>
    o.arguments
      .filter((a) => a.type === 'support' && a.confidence >= 70)
      .map((a) => ({ expert: o.expert, text: a.text, confidence: a.confidence })),
  );
  const opposeArgs = opinions.flatMap((o) =>
    o.arguments
      .filter((a) => a.type === 'oppose' && a.confidence >= 65)
      .map((a) => ({ expert: o.expert, text: a.text, confidence: a.confidence })),
  );

  // 6. 目标价区间（当前价 × (1+E[r]) × (1±band)）
  const { low, high } = targetPriceRange(valuation.currentPrice, expectedReturn);

  // 7. 关键假设（动态提取）
  const optimisticAssumptions = extractKeyAssumptions(supportArgs, financial, n, 'optimistic');
  const pessimisticAssumptions = extractKeyAssumptions(opposeArgs, financial, n, 'pessimistic');
  const neutralAssumptions = generateNeutralAssumptions(financial, valuation, n);

  return [
    {
      name: '乐观',
      probability: norm.optimistic,
      keyAssumptions: optimisticAssumptions,
      targetPriceRange: { low, high },
      supportingArguments: supportArgs.slice(0, 5),
      preconditions: ['宏观经济稳定', '行业政策无重大变化', '公司战略执行顺利'],
    },
    {
      name: '中性',
      probability: norm.neutral,
      keyAssumptions: neutralAssumptions,
      targetPriceRange: { low, high },
      supportingArguments: [],
      preconditions: ['当前经营趋势延续', '估值中枢不发生重大迁移'],
    },
    {
      name: '悲观',
      probability: norm.pessimistic,
      keyAssumptions: pessimisticAssumptions,
      targetPriceRange: { low, high },
      supportingArguments: opposeArgs.slice(0, 5),
      preconditions: ['行业景气度持续下行', '政策利空兑现', '市场竞争加剧'],
    },
  ];
}

/**
 * 从专家论点中动态提取关键假设
 */
function extractKeyAssumptions(
  args: { expert: string; text: string; confidence: number }[],
  financial: FinancialData,
  n: number,
  scenario: 'optimistic' | 'pessimistic',
): string[] {
  const assumptions: string[] = [];
  const themeKeywords = ['毛利率', 'ROE', '现金流', '增速', '估值', '行业', '竞争', '景气', '杠杆', '分红'];
  for (const keyword of themeKeywords) {
    const matchedArgs = args.filter((a) => a.text.includes(keyword));
    if (matchedArgs.length > 0) {
      const avgConfidence = matchedArgs.reduce((s, a) => s + a.confidence, 0) / matchedArgs.length;
      if (scenario === 'optimistic') {
        assumptions.push(`${keyword}表现积极（置信度${Math.round(avgConfidence)}%）`);
      } else {
        assumptions.push(`${keyword}存在压力（置信度${Math.round(avgConfidence)}%）`);
      }
    }
    if (assumptions.length >= 4) break;
  }

  if (assumptions.length < 3) {
    const latestGrowth = n >= 2
      ? ((financial.netProfit[n - 1] - financial.netProfit[n - 2]) / financial.netProfit[n - 2]) * 100
      : 0;
    const avgROE = financial.roe.reduce((a, b) => a + b, 0) / n;
    if (scenario === 'optimistic') {
      if (latestGrowth > 10) assumptions.push(`利润增速${latestGrowth.toFixed(1)}%保持强劲`);
      if (avgROE > 15) assumptions.push(`ROE ${avgROE.toFixed(1)}%盈利能力优秀`);
    } else {
      if (latestGrowth < 5) assumptions.push(`利润增速放缓至${latestGrowth.toFixed(1)}%`);
      if (avgROE < 10) assumptions.push(`ROE ${avgROE.toFixed(1)}%盈利能力一般`);
    }
  }
  return assumptions.slice(0, 5);
}

function generateNeutralAssumptions(
  financial: FinancialData,
  valuation: ValuationData,
  n: number,
): string[] {
  const assumptions: string[] = [];
  const latestGrowth = n >= 2
    ? ((financial.netProfit[n - 1] - financial.netProfit[n - 2]) / financial.netProfit[n - 2]) * 100
    : 0;
  const avgGM = financial.grossMargin.reduce((a, b) => a + b, 0) / n;
  const pePercentile = valuation.historicalPE.length > 0
    ? (valuation.historicalPE.filter((h) => h.pe <= valuation.pe).length / valuation.historicalPE.length) * 100
    : 50;
  assumptions.push(`利润增速维持当前水平（${latestGrowth.toFixed(1)}%）`);
  assumptions.push(`毛利率保持稳定（均值${avgGM.toFixed(1)}%）`);
  assumptions.push(`估值处于历史${pePercentile.toFixed(0)}%分位，中枢暂无明显迁移`);
  return assumptions;
}
