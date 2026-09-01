import type { FinancialData, ValuationData, StockInfo, ExpertOpinion } from '../../types.js';
import { safeDiv } from '../safeDiv.js';
import { runExpertWithLLM } from '../../llm/expertRunner.js';
import { formatContext } from '../../llm/prompts.js';

const EXPERT_NAME = '资金筹码分析师';

const SYSTEM_PROMPT = `你是资金筹码分析师，专注 A 股资金面与筹码结构分析。
重要数据局限：本专家无法获取实时资金流、股东持仓变动、融资融券、龙虎榜等数据，所有结论均基于量价关系和财务数据间接推断，属推断性质，confidence 整体偏低（建议 40-60）。
分析维度：
- 市值流动性：大市值流动性充裕，小市值存在冲击成本风险
- 筹码稳定性：基于现金流质量与 ROE 稳定性推断长线筹码锁定性
- 机构配置偏好：基于市值占比、PE 与同业对比推断机构认可度
- 营收增速趋势：业务扩张/收缩间接反映资金关注度变化
要求：
- 所有论点必须明确标注推断性质，避免给出确定性资金流向结论
- confidence 控制在 40-65 区间，局限性声明可作为高置信 fact
- evidenceType 标注：fact=市值/财务等可直接观测数据，inference=基于数据的推断，hypothesis=假设性判断
- overallSentiment 由推断的资金偏好综合判断，无明显信号时 default 为 neutral`;

/**
 * 规则引擎研判（LLM 不可用时降级使用）
 */
function capitalFlowExpertRule(
  financial: FinancialData,
  valuation: ValuationData,
  _info: StockInfo,
): ExpertOpinion {
  const n = financial.years.length;
  const arguments_: ExpertOpinion['arguments'] = [];
  const keyPoints: string[] = [];

  // === 1. 成交量趋势分析：基于营收规模变化推断业务扩张/收缩 ===
  const revenueGrowthRates: number[] = [];
  for (let i = 1; i < n; i++) {
    revenueGrowthRates.push(
      safeDiv(financial.revenue[i] - financial.revenue[i - 1], financial.revenue[i - 1]) * 100,
    );
  }
  const avgRevenueGrowth =
    revenueGrowthRates.reduce((a, b) => a + b, 0) / revenueGrowthRates.length;
  const latestRevenueGrowth = revenueGrowthRates[revenueGrowthRates.length - 1];

  if (avgRevenueGrowth > 15) {
    arguments_.push({
      text: `营收年均增速${avgRevenueGrowth.toFixed(1)}%，业务持续扩张，推断市场资金对该股关注度较高（间接推断，无实时资金流数据）`,
      confidence: 45,
      type: 'support',
      evidenceType: 'inference',
    });
    keyPoints.push(`营收高增长${avgRevenueGrowth.toFixed(0)}%，推断资金关注度高`);
  } else if (avgRevenueGrowth > 0) {
    arguments_.push({
      text: `营收年均增速${avgRevenueGrowth.toFixed(1)}%，业务温和扩张，资金关注度中等`,
      confidence: 40,
      type: 'support',
      evidenceType: 'inference',
    });
  } else {
    arguments_.push({
      text: `营收年均增速${avgRevenueGrowth.toFixed(1)}%，业务收缩，推断资金可能逐步撤离`,
      confidence: 45,
      type: 'oppose',
      evidenceType: 'inference',
    });
    keyPoints.push(`营收收缩${avgRevenueGrowth.toFixed(1)}%，推断资金可能撤离`);
  }

  // 最新增速趋势
  if (latestRevenueGrowth > avgRevenueGrowth + 10) {
    arguments_.push({
      text: `最新营收增速${latestRevenueGrowth.toFixed(1)}%显著高于均值，业务加速扩张或吸引增量资金`,
      confidence: 42,
      type: 'support',
      evidenceType: 'inference',
    });
  } else if (latestRevenueGrowth < avgRevenueGrowth - 10) {
    arguments_.push({
      text: `最新营收增速${latestRevenueGrowth.toFixed(1)}%显著低于均值，业务减速或资金热度消退`,
      confidence: 42,
      type: 'oppose',
      evidenceType: 'inference',
    });
  }

  // === 2. 估值与市值关系：当前市值 vs 同业，判断资金偏好 ===
  if (valuation.peerComparison.length > 0) {
    const totalPeerCap = valuation.peerComparison.reduce((s, p) => s + p.marketCap, 0);
    const companyShare = safeDiv(valuation.marketCap, valuation.marketCap + totalPeerCap) * 100;
    const peerAvgPE = safeDiv(
      valuation.peerComparison.reduce((s, p) => s + p.pe, 0),
      valuation.peerComparison.length,
    );

    if (companyShare > 40) {
      arguments_.push({
        text: `市值占同业合计${companyShare.toFixed(0)}%，龙头地位突出，机构资金配置偏好标的`,
        confidence: 55,
        type: 'support',
        evidenceType: 'inference',
      });
      keyPoints.push(`市值占比${companyShare.toFixed(0)}%，龙头配置价值突出`);
    } else if (companyShare < 15) {
      arguments_.push({
        text: `市值占同业合计仅${companyShare.toFixed(0)}%，体量偏小，机构覆盖度可能有限`,
        confidence: 48,
        type: 'oppose',
        evidenceType: 'inference',
      });
    }

    // PE溢价/折价判断资金态度
    if (valuation.pe < peerAvgPE * 0.7) {
      arguments_.push({
        text: `PE ${valuation.pe}x低于同业均值${peerAvgPE.toFixed(1)}x约30%+，可能存在估值折价，资金未充分认可`,
        confidence: 50,
        type: 'oppose',
        evidenceType: 'inference',
      });
    } else if (valuation.pe > peerAvgPE * 1.3) {
      arguments_.push({
        text: `PE ${valuation.pe}x高于同业均值${peerAvgPE.toFixed(1)}x，资金给予溢价认可，但需警惕高估值回调`,
        confidence: 48,
        type: 'support',
        evidenceType: 'hypothesis',
      });
    }
  }

  // === 3. 流动性评估：基于市值和估值水平判断流动性 ===
  // valuation.marketCap 已是亿元单位（如 16514 = 1.65万亿）
  const capYi = valuation.marketCap; // 亿元
  const capDisplay =
    capYi >= 10000 ? `${(capYi / 10000).toFixed(2)}万亿元` : `${capYi.toFixed(0)}亿元`;
  const capDisplayShort =
    capYi >= 10000 ? `${(capYi / 10000).toFixed(2)}万亿` : `${capYi.toFixed(0)}亿`;

  if (capYi > 10000) {
    arguments_.push({
      text: `市值超${capDisplay}，大盘股流动性充裕，大资金进出冲击成本较低`,
      confidence: 60,
      type: 'support',
      evidenceType: 'fact',
    });
    keyPoints.push(`大市值${capDisplayShort}，流动性充裕`);
  } else if (capYi > 2000) {
    arguments_.push({
      text: `市值${capDisplay}，中盘股流动性适中`,
      confidence: 55,
      type: 'support',
      evidenceType: 'fact',
    });
  } else {
    arguments_.push({
      text: `市值仅${capDisplay}，小盘股流动性偏弱，大资金进出存在冲击风险`,
      confidence: 50,
      type: 'oppose',
      evidenceType: 'fact',
    });
    keyPoints.push(`小市值${capDisplayShort}，流动性偏弱`);
  }

  // === 4. 筹码稳定性：基于市值稳定性和盈利质量推断 ===
  const cashFlowRatios = financial.operatingCashFlow.map((cf, i) =>
    safeDiv(cf, financial.netProfit[i]),
  );
  const avgCashFlowRatio = cashFlowRatios.reduce((a, b) => a + b, 0) / n;
  const roeStability = Math.max(...financial.roe) - Math.min(...financial.roe);

  if (avgCashFlowRatio > 0.9 && roeStability < 5) {
    arguments_.push({
      text: `现金流/净利润${avgCashFlowRatio.toFixed(2)}且ROE波动仅${roeStability.toFixed(1)}个百分点，盈利质量高且稳定，推断长线筹码锁定性好`,
      confidence: 52,
      type: 'support',
      evidenceType: 'inference',
    });
    keyPoints.push('盈利质量高且稳定，推断筹码锁定性好');
  } else if (avgCashFlowRatio < 0.3) {
    arguments_.push({
      text: `现金流/净利润仅${avgCashFlowRatio.toFixed(2)}，盈利含金量不足，推断筹码结构松散、短线博弈比例可能偏高`,
      confidence: 45,
      type: 'oppose',
      evidenceType: 'hypothesis',
    });
    keyPoints.push('盈利含金量不足，筹码结构可能松散');
  } else {
    arguments_.push({
      text: `现金流/净利润${avgCashFlowRatio.toFixed(2)}处于中等水平，筹码稳定性一般`,
      confidence: 40,
      type: 'support',
      evidenceType: 'inference',
    });
  }

  // === 局限性声明 ===
  arguments_.push({
    text: '【局限性声明】本专家无法获取实时资金流、股东持仓变动、融资融券等数据，所有结论均基于财务指标间接推断，置信度整体偏低，仅供参考',
    confidence: 90,
    type: 'oppose',
    evidenceType: 'hypothesis',
  });

  // 确定整体情绪
  const supportCount = arguments_.filter((a) => a.type === 'support').length;
  const opposeCount = arguments_.filter((a) => a.type === 'oppose').length;
  const totalArgs = arguments_.length || 1;
  let overallSentiment: 'bullish' | 'neutral' | 'bearish' = 'neutral';
  if (supportCount > opposeCount + 2) overallSentiment = 'bullish';
  else if (opposeCount > supportCount + 2) overallSentiment = 'bearish';

  const avgConfidence = Math.round(arguments_.reduce((s, a) => s + a.confidence, 0) / totalArgs);

  return {
    expert: EXPERT_NAME,
    arguments: arguments_,
    overallSentiment,
    confidence: avgConfidence,
    keyPoints: keyPoints.slice(0, 6),
  };
}

/**
 * 资金筹码分析师
 * LLM 可用时调用 LLM 进行深度研判；不可用或失败时降级规则引擎。
 */
export async function capitalFlowExpert(
  financial: FinancialData,
  valuation: ValuationData,
  info: StockInfo,
): Promise<ExpertOpinion> {
  return runExpertWithLLM({
    expertName: EXPERT_NAME,
    systemPrompt: SYSTEM_PROMPT,
    context: formatContext(financial, valuation, info),
    ruleFallback: () => capitalFlowExpertRule(financial, valuation, info),
  });
}
