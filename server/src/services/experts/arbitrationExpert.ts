import type {
  FinancialData,
  ValuationData,
  StockInfo,
  ExpertOpinion,
  ControversyPoint,
} from '../../types.js';
import { safeDiv } from '../safeDiv.js';
import { isLLMAvailable, chatJSON, type ChatMessage } from '../../llm/index.js';
import { formatContext } from '../../llm/prompts.js';
import logger from '../../utils/logger.js';

export interface ArbitrationInput {
  financial: FinancialData;
  valuation: ValuationData;
  info: StockInfo;
  opinions: ExpertOpinion[];
  /**
   * 该股票历史评级的事后校准提示（可选；样本不足时为 null）。
   * 决策-结果闭环：把"历次评级是否兑现"的统计注入仲裁，
   * 让仲裁在系统性偏乐观/悲观时能自我校准（借鉴 TradingAgents 的 decision log 反思注入）。
   */
  ratingAccuracy?: string | null;
}

const EXPERT_NAME = '数据仲裁官（综合研判）';

const SYSTEM_PROMPT = `你是数据仲裁官，负责综合多位独立专家的研判意见，给出最终裁决。
你的职责：
1. 识别专家共识（多数专家一致认可的点）
2. 识别专家分歧（存在对立观点的关键议题）
3. 对每个分歧给出客观仲裁（综合双方论据 + 数据事实）
4. 给出最终综合研判与投资定位建议
要求：不偏袒任何一方，以数据事实为依据；controversies 聚焦 3-4 个关键争议；finalOpinion 给出明确整体判断`;

function arbitrationExpertRule(input: ArbitrationInput): {
  controversies: ControversyPoint[];
  finalOpinion: ExpertOpinion;
} {
  const { opinions, info, financial, valuation } = input;
  const n = financial.years.length;

  // 统计各专家情绪
  const bullishCount = opinions.filter((o) => o.overallSentiment === 'bullish').length;
  const bearishCount = opinions.filter((o) => o.overallSentiment === 'bearish').length;
  const neutralCount = opinions.filter((o) => o.overallSentiment === 'neutral').length;

  // 识别共识点
  const allKeyPoints = opinions.flatMap((o) => o.keyPoints);
  const consensusPoints: string[] = [];
  const divergencePoints: string[] = [];

  // 共识：所有专家都提到的正面因素
  const positiveThemes = ['护城河', '品牌', '现金流', 'ROE', '毛利率', '商誉'];
  for (const theme of positiveThemes) {
    const mentioned = allKeyPoints.filter((p) => p.includes(theme));
    if (mentioned.length >= 3) {
      consensusPoints.push(theme);
    }
  }

  // 分歧点
  const divergenceThemes = ['估值', '增速', '行业', '政策', '消费', '资金', '量能', '换手'];
  for (const theme of divergenceThemes) {
    const supporters = opinions.filter((o) =>
      o.arguments.some((a) => a.text.includes(theme) && a.type === 'support'),
    );
    const opposers = opinions.filter((o) =>
      o.arguments.some((a) => a.text.includes(theme) && a.type === 'oppose'),
    );
    if (supporters.length > 0 && opposers.length > 0) {
      divergencePoints.push(theme);
    }
  }

  // === 预计算公共指标 ===
  const peValues = valuation.historicalPE.map((h) => h.pe).sort((a, b) => a - b);
  const pePercentile =
    peValues.length > 0
      ? safeDiv(peValues.filter((p) => p <= valuation.pe).length, peValues.length) * 100
      : 50;

  const latestGrowth =
    financial.netProfit[n - 2] !== 0
      ? ((financial.netProfit[n - 1] - financial.netProfit[n - 2]) /
          Math.abs(financial.netProfit[n - 2])) *
        100
      : 0;
  const avgGrowth =
    n >= 2 && financial.netProfit[0] > 0 && financial.netProfit[n - 1] > 0
      ? (Math.pow(financial.netProfit[n - 1] / financial.netProfit[0], 1 / (n - 1)) - 1) * 100
      : 0;

  const cashFlowRatio =
    financial.netProfit[n - 1] !== 0
      ? financial.operatingCashFlow[n - 1] / financial.netProfit[n - 1]
      : 0;
  const grossMarginLatest = financial.grossMargin[n - 1];
  const grossMarginTrend = n >= 2 ? financial.grossMargin[n - 1] - financial.grossMargin[n - 2] : 0;
  const grossMarginStability =
    Math.max(...financial.grossMargin) - Math.min(...financial.grossMargin);
  const debtRatioLatest = financial.debtRatio[n - 1];

  const revenueGrowthLatest =
    financial.revenue[n - 2] !== 0
      ? ((financial.revenue[n - 1] - financial.revenue[n - 2]) /
          Math.abs(financial.revenue[n - 2])) *
        100
      : 0;
  const revenueGrowthPrev =
    n >= 3 && financial.revenue[n - 3] !== 0
      ? ((financial.revenue[n - 2] - financial.revenue[n - 3]) /
          Math.abs(financial.revenue[n - 3])) *
        100
      : 0;

  const hasPeerData = valuation.peerComparison.length > 0;
  const peerAvgPE = hasPeerData
    ? safeDiv(
        valuation.peerComparison.reduce((s, p) => s + p.pe, 0),
        valuation.peerComparison.length,
      )
    : 0;

  // 构建争议点
  const controversies: ControversyPoint[] = [];

  // === 争议1：估值水平是否合理 ===
  const peSafeMargin = pePercentile <= 30;
  const peHighRisk = pePercentile >= 70;
  const peMidRange = !peSafeMargin && !peHighRisk;

  let bullValuation: string;
  if (peSafeMargin) {
    bullValuation = `PE ${valuation.pe}x处于历史${pePercentile.toFixed(0)}%分位，估值已充分反映悲观预期，安全边际较高。`;
  } else if (peMidRange) {
    bullValuation = `PE ${valuation.pe}x处于合理区间，估值与基本面匹配度尚可。`;
  } else {
    bullValuation = `PE ${valuation.pe}x虽处于较高分位，但考虑到${info.industry}行业龙头溢价，估值仍有一定支撑。`;
  }

  let bearValuation: string;
  if (peHighRisk) {
    bearValuation = `PE ${valuation.pe}x处于历史${pePercentile.toFixed(0)}%分位高位，估值泡沫风险不容忽视。`;
  } else if (hasPeerData) {
    bearValuation = `${info.industry}同业平均PE仅${peerAvgPE.toFixed(1)}x，估值中枢可能进一步下移。`;
  } else {
    bearValuation = `${info.industry}行业估值中枢可能下移，当前未必是底。`;
  }

  let arbValuation = `PE历史分位${pePercentile.toFixed(0)}%，${peSafeMargin ? '具备一定安全边际' : peHighRisk ? '估值偏高需注意风险' : '估值处于合理区间'}。`;
  if (hasPeerData) {
    arbValuation +=
      valuation.pe > peerAvgPE
        ? `结合同业对比看，当前估值高于${info.industry}同业均值${peerAvgPE.toFixed(1)}x，存在溢价。`
        : `结合同业对比看，当前估值低于${info.industry}同业均值${peerAvgPE.toFixed(1)}x，存在折价。`;
  }

  controversies.push({
    topic: '当前估值水平是否合理',
    bullishView: bullValuation,
    bearishView: bearValuation,
    arbitration: arbValuation,
    confidence: Math.round(60 + Math.abs(50 - pePercentile) * 0.2),
  });

  // === 争议2：盈利增长可持续性 ===
  const growthStrong = latestGrowth > 15;
  const growthWeak = latestGrowth < 10 || latestGrowth < avgGrowth * 0.7;
  const growthDecel = latestGrowth < avgGrowth;

  let bullGrowth: string;
  if (growthStrong) {
    bullGrowth = `${info.name}最新净利润增速${latestGrowth.toFixed(1)}%，${n}年复合增长率${avgGrowth.toFixed(1)}%，增长动力强劲，${info.industry}行业景气度支撑持续增长。`;
  } else if (latestGrowth > 0) {
    bullGrowth = `${info.name}保持正增长（最新${latestGrowth.toFixed(1)}%），${n}年复合增长率${avgGrowth.toFixed(1)}%，在${info.industry}行业中展现韧性。`;
  } else {
    bullGrowth = `${info.name}虽短期承压，但${n}年复合增长率${avgGrowth.toFixed(1)}%显示中长期增长基础仍在。`;
  }

  let bearGrowth: string;
  if (growthWeak && growthDecel) {
    bearGrowth = `增速已从${avgGrowth.toFixed(1)}%（复合）回落至${latestGrowth.toFixed(1)}%，${info.industry}行业需求承压，基数效应加大，维持高增长难度显著上升。`;
  } else if (growthDecel) {
    bearGrowth = `增速呈放缓趋势（从复合${avgGrowth.toFixed(1)}%降至最新${latestGrowth.toFixed(1)}%），${info.industry}行业竞争加剧可能进一步压制增长空间。`;
  } else if (latestGrowth <= 0) {
    bearGrowth = `最新净利润出现负增长（${latestGrowth.toFixed(1)}%），${info.industry}行业基本面恶化风险需警惕。`;
  } else {
    bearGrowth = `增速虽为正但低于市场期望，${info.industry}行业整体增速放缓可能限制上行空间。`;
  }

  const growthForecast =
    latestGrowth > 15
      ? '中高速'
      : latestGrowth > 10
        ? '中速'
        : latestGrowth > 5
          ? '中低速'
          : '低速';
  const growthSupport =
    grossMarginLatest > 30 ? '高毛利率提供利润缓冲' : '毛利率偏低需关注成本控制';

  controversies.push({
    topic: '盈利增长可持续性',
    bullishView: bullGrowth,
    bearishView: bearGrowth,
    arbitration: `${info.name}未来利润增速大概率维持${growthForecast}水平（最新${latestGrowth.toFixed(1)}%，复合${avgGrowth.toFixed(1)}%）。${growthSupport}，但${info.industry}行业整体增长空间有限，市场需合理调整增长预期。`,
    confidence: Math.round(55 + Math.min(20, Math.abs(latestGrowth - avgGrowth) * 0.5)),
  });

  // === 争议3：财务质量与风险 ===
  const cashFlowGood = cashFlowRatio > 0.8;
  const cashFlowBad = cashFlowRatio < 0.5;
  const marginStable = grossMarginStability < 5;
  const debtHigh = debtRatioLatest > 60;
  const debtLow = debtRatioLatest < 40;

  let bullFinancial: string;
  if (cashFlowGood && marginStable) {
    bullFinancial = `经营现金流/净利润达${cashFlowRatio.toFixed(2)}，毛利率波动仅${grossMarginStability.toFixed(1)}个百分点，盈利质量高且稳定。`;
  } else if (cashFlowGood) {
    bullFinancial = `经营现金流/净利润达${cashFlowRatio.toFixed(2)}，现金回收能力强，盈利真实性高。`;
  } else if (marginStable) {
    bullFinancial = `毛利率波动仅${grossMarginStability.toFixed(1)}个百分点，盈利稳定性高，${info.industry}行业竞争格局相对清晰。`;
  } else {
    bullFinancial = `ROE ${financial.roe[n - 1].toFixed(1)}%处于${info.industry}行业较好水平，资产运营效率尚可。`;
  }

  let bearFinancial: string;
  if (cashFlowBad && debtHigh) {
    bearFinancial = `经营现金流/净利润仅${cashFlowRatio.toFixed(2)}，资产负债率${debtRatioLatest.toFixed(1)}%偏高，盈利质量和偿债能力双重承压。`;
  } else if (cashFlowBad) {
    bearFinancial = `经营现金流/净利润仅${cashFlowRatio.toFixed(2)}，盈利含金量不足，需关注应收账款和收入确认质量。`;
  } else if (debtHigh) {
    bearFinancial = `资产负债率${debtRatioLatest.toFixed(1)}%偏高，财务杠杆较大，利率上行或融资收紧时风险敞口增加。`;
  } else if (!marginStable) {
    bearFinancial = `毛利率波动${grossMarginStability.toFixed(1)}个百分点，盈利稳定性较差，${info.industry}行业竞争格局可能恶化。`;
  } else {
    bearFinancial = `财务指标整体中性，需进一步关注${info.industry}行业特有财务风险。`;
  }

  const financialQuality = cashFlowGood ? '现金流充裕' : cashFlowBad ? '现金流承压' : '现金流适中';
  const financialRisk = debtHigh ? '杠杆偏高需关注' : debtLow ? '财务结构稳健' : '杠杆水平适中';

  controversies.push({
    topic: '财务质量与风险',
    bullishView: bullFinancial,
    bearishView: bearFinancial,
    arbitration: `${info.name}${financialQuality}，${financialRisk}。现金流/净利润比${cashFlowRatio.toFixed(2)}，毛利率${grossMarginLatest.toFixed(1)}%（波动${grossMarginStability.toFixed(1)}个百分点），资产负债率${debtRatioLatest.toFixed(1)}%。整体财务质量${cashFlowGood && !debtHigh ? '较好' : cashFlowBad || debtHigh ? '需关注' : '中等'}。`,
    confidence: Math.round(
      60 +
        (cashFlowGood ? 10 : cashFlowBad ? -5 : 5) +
        (marginStable ? 5 : -5) +
        (debtHigh ? -5 : 5),
    ),
  });

  // === 争议4：行业周期与政策环境 ===
  const revenueTrendUp = revenueGrowthLatest > revenueGrowthPrev;
  const revenueTrendDown = revenueGrowthLatest < revenueGrowthPrev;
  const marginTrendUp = grossMarginTrend > 0;
  const marginTrendDown = grossMarginTrend < 0;

  let bullIndustry: string;
  if (revenueTrendUp && marginTrendUp) {
    bullIndustry = `${info.industry}行业景气度回升，${info.name}营收增速${revenueGrowthLatest.toFixed(1)}%（前值${revenueGrowthPrev.toFixed(1)}%），毛利率同步改善（+${grossMarginTrend.toFixed(1)}个百分点），行业供需格局优化。`;
  } else if (revenueTrendUp) {
    bullIndustry = `${info.industry}行业需求回暖，${info.name}营收增速提升至${revenueGrowthLatest.toFixed(1)}%，行业集中度提升利好龙头。`;
  } else if (marginTrendUp) {
    bullIndustry = `${info.industry}行业竞争格局改善，${info.name}毛利率提升${grossMarginTrend.toFixed(1)}个百分点，定价能力增强。`;
  } else {
    bullIndustry = `${info.industry}行业虽处调整期，但${info.name}作为龙头仍具韧性，市场份额有望逆势提升。`;
  }

  let bearIndustry: string;
  if (revenueTrendDown && marginTrendDown) {
    bearIndustry = `${info.industry}行业景气度下行，${info.name}营收增速放缓至${revenueGrowthLatest.toFixed(1)}%（前值${revenueGrowthPrev.toFixed(1)}%），毛利率同步下滑（${grossMarginTrend.toFixed(1)}个百分点），行业量价齐跌风险。`;
  } else if (revenueTrendDown) {
    bearIndustry = `${info.industry}行业需求放缓，${info.name}营收增速从${revenueGrowthPrev.toFixed(1)}%降至${revenueGrowthLatest.toFixed(1)}%，行业总量增长见顶。`;
  } else if (marginTrendDown) {
    bearIndustry = `${info.industry}行业竞争加剧，${info.name}毛利率下滑${Math.abs(grossMarginTrend).toFixed(1)}个百分点，价格战或成本压力显现。`;
  } else {
    bearIndustry = `${info.industry}行业面临政策或结构性调整压力，${info.name}虽暂时稳健但行业β机会减弱。`;
  }

  const industryCycle = revenueTrendUp ? '景气回升' : revenueTrendDown ? '景气下行' : '平稳运行';
  const competitionTrend = marginTrendUp
    ? '竞争格局改善'
    : marginTrendDown
      ? '竞争加剧'
      : '竞争格局稳定';

  controversies.push({
    topic: '行业周期与政策环境',
    bullishView: bullIndustry,
    bearishView: bearIndustry,
    arbitration: `${info.industry}行业当前处于${industryCycle}阶段，${info.name}营收增速${revenueGrowthLatest.toFixed(1)}%，毛利率趋势${marginTrendUp ? '改善' : marginTrendDown ? '恶化' : '平稳'}（${grossMarginTrend >= 0 ? '+' : ''}${grossMarginTrend.toFixed(1)}个百分点）。${competitionTrend}，但需关注宏观政策和行业监管变化对${info.industry}行业的潜在影响。`,
    confidence: Math.round(58 + (revenueTrendUp === marginTrendUp ? 8 : 0)),
  });

  // === 最终综合判断 ===
  const avgConfidence = safeDiv(
    opinions.reduce((s, o) => s + o.confidence, 0),
    opinions.length,
  );
  const supportArgs = opinions
    .flatMap((o) => o.arguments.filter((a) => a.type === 'support'))
    .slice(0, 4);
  const opposeArgs = opinions
    .flatMap((o) => o.arguments.filter((a) => a.type === 'oppose'))
    .slice(0, 3);

  // 动态评估基本面描述（n=0 时以 safeDiv 退化为 0，避免除零导致 downstream "优秀/稳健" 误判）
  const avgROE = safeDiv(
    financial.roe.reduce((a, b) => a + b, 0),
    n,
  );
  const fundamentalLevel =
    avgROE > 20 && grossMarginLatest > 30
      ? '优秀'
      : avgROE > 10 && grossMarginLatest > 20
        ? '良好'
        : avgROE > 5 && grossMarginLatest > 10
          ? '中等'
          : '偏弱';

  // 动态定位建议
  const positioningAdvice =
    bullishCount >= 3 && bearishCount <= 1
      ? '优先跟踪'
      : bullishCount >= 2
        ? '持续观察'
        : bearishCount >= 3
          ? '建议规避'
          : '谨慎观望';

  const finalOpinion: ExpertOpinion = {
    expert: '数据仲裁官（综合研判）',
    arguments: [...supportArgs, ...opposeArgs],
    overallSentiment:
      bullishCount > bearishCount ? 'bullish' : neutralCount >= 2 ? 'neutral' : 'bearish',
    confidence: Math.round(avgConfidence),
    keyPoints: [
      `专家共识：${consensusPoints.length > 0 ? consensusPoints.join('、') : '各维度均有涉及'}等方面表现突出`,
      `主要分歧：${divergencePoints.length > 0 ? divergencePoints.join('、') : '各维度判断较为一致'}等维度存在判断差异`,
      `${bullishCount}位专家看多，${neutralCount}位中性，${bearishCount}位看空`,
      `综合判断：基本面${fundamentalLevel}，${info.industry}行业周期与估值变化构成主要影响因素`,
      `建议定位：${info.name}${positioningAdvice}，需结合估值分位与行业趋势择机决策`,
    ],
  };

  return { controversies, finalOpinion };
}

/** LLM 返回的仲裁结构 */
interface RawArbitration {
  controversies?: unknown[];
  finalOpinion?: {
    arguments?: unknown[];
    overallSentiment?: string;
    confidence?: number;
    keyPoints?: unknown[];
  };
}

const ARBITRATION_SCHEMA = `请严格返回如下 JSON 结构（不要输出任何其他内容）：
{
  "controversies": [
    { "topic": "争议议题", "bullishView": "看多观点", "bearishView": "看空观点", "arbitration": "仲裁结论", "confidence": 0到100的整数 }
  ],
  "finalOpinion": {
    "arguments": [{ "text": "论点", "confidence": 0-100, "type": "support"或"oppose", "evidenceType": "fact"或"inference"或"hypothesis" }],
    "overallSentiment": "bullish"或"neutral"或"bearish",
    "confidence": 0-100,
    "keyPoints": ["要点"]
  }
}
要求：controversies 3-4 个；finalOpinion.arguments 4-8 条含 support 与 oppose；keyPoints 3-6 条`;

/**
 * 数据仲裁官
 * LLM 可用时综合所有专家意见进行真 LLM 仲裁；不可用或失败时降级规则引擎。
 */
export async function arbitrationExpert(input: ArbitrationInput): Promise<{
  controversies: ControversyPoint[];
  finalOpinion: ExpertOpinion;
}> {
  if (!isLLMAvailable()) return arbitrationExpertRule(input);

  // 构建专家意见摘要供 LLM 仲裁
  const opinionsBrief = input.opinions
    .map((o) => {
      const args = o.arguments.map((a) => `[${a.type}]${a.text}(置信${a.confidence})`).join('; ');
      return `【${o.expert}】情绪:${o.overallSentiment} 置信:${o.confidence}\n论点: ${args}\n要点: ${o.keyPoints.join('；')}`;
    })
    .join('\n\n');

  // 事后校准提示：有历史样本时附加，供仲裁校准自信程度
  const accuracyBlock = input.ratingAccuracy
    ? `\n\n=== 历史评级事后校准（决策-结果闭环）===\n${input.ratingAccuracy}`
    : '';

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `${formatContext(input.financial, input.valuation, input.info)}\n\n=== 各专家研判意见 ===\n${opinionsBrief}${accuracyBlock}\n\n${ARBITRATION_SCHEMA}`,
    },
  ];

  try {
    const raw = await chatJSON<RawArbitration>(messages, {
      temperature: 0.4,
      maxTokens: 2500,
      timeout: 60000,
    });
    return normalizeArbitration(raw);
  } catch (err) {
    logger.warn('[LLM] 仲裁专家降级规则引擎', { err: err as Error });
    return arbitrationExpertRule(input);
  }
}

/** 规范化 LLM 返回的仲裁结果，确保类型安全 */
function normalizeArbitration(raw: RawArbitration): {
  controversies: ControversyPoint[];
  finalOpinion: ExpertOpinion;
} {
  const clamp = (v: unknown, min: number, max: number, fb: number) => {
    const n = Number(v);
    return isFinite(n) ? Math.round(Math.min(max, Math.max(min, n))) : fb;
  };
  const validSentiments = ['bullish', 'neutral', 'bearish'] as const;
  const validTypes = ['support', 'oppose'] as const;
  const validEvidence = ['fact', 'inference', 'hypothesis'] as const;

  const controversies: ControversyPoint[] = Array.isArray(raw.controversies)
    ? raw.controversies
        .map((c) => {
          const item = c as Record<string, unknown>;
          return {
            topic: String(item.topic || ''),
            bullishView: String(item.bullishView || ''),
            bearishView: String(item.bearishView || ''),
            arbitration: String(item.arbitration || ''),
            confidence: clamp(item.confidence, 0, 100, 60),
          };
        })
        .filter((c) => c.topic && c.arbitration)
    : [];

  const fo = raw.finalOpinion || {};
  const arguments_ = Array.isArray(fo.arguments)
    ? fo.arguments
        .map((a) => {
          const arg = a as Record<string, unknown>;
          return {
            text: String(arg.text || ''),
            confidence: clamp(arg.confidence, 0, 100, 50),
            type: validTypes.includes(arg.type as (typeof validTypes)[number])
              ? (arg.type as 'support' | 'oppose')
              : 'support',
            evidenceType: validEvidence.includes(arg.evidenceType as (typeof validEvidence)[number])
              ? (arg.evidenceType as 'fact' | 'inference' | 'hypothesis')
              : 'inference',
          };
        })
        .filter((a) => a.text)
    : [];
  const sentiment = validSentiments.includes(
    fo.overallSentiment as (typeof validSentiments)[number],
  )
    ? (fo.overallSentiment as 'bullish' | 'neutral' | 'bearish')
    : 'neutral';
  const keyPoints = Array.isArray(fo.keyPoints)
    ? fo.keyPoints.map((p) => String(p)).filter((p) => p)
    : [];

  return {
    controversies: controversies.slice(0, 4),
    finalOpinion: {
      expert: EXPERT_NAME,
      arguments: arguments_.slice(0, 8),
      overallSentiment: sentiment,
      confidence: clamp(fo.confidence, 0, 100, 60),
      keyPoints: keyPoints.slice(0, 6),
    },
  };
}
