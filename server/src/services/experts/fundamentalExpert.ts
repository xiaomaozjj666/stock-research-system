import type { FinancialData, ValuationData, StockInfo, ExpertOpinion } from '../../types.js';
import { safeDiv } from '../safeDiv.js';
import { runExpertWithLLM } from '../../llm/expertRunner.js';
import { formatContext } from '../../llm/prompts.js';

const EXPERT_NAME = '基本面财务专家';

const SYSTEM_PROMPT = `你是资深基本面财务分析师，专注 A 股上市公司财务质量评估，拥有 15 年投研经验。
分析维度：盈利能力（毛利率/净利率/ROE）、成长性（营收与利润增速）、现金流质量（经营现金流/净利润）、
财务结构（资产负债率/商誉/应收账款）、盈利稳定性（毛利率波动）。
要求：
- 数据驱动，每个论点必须引用具体数据
- 既指出优势也指出风险，避免单边倾向
- evidenceType 标注：fact=直接数据事实，inference=基于数据的推断，hypothesis=假设性判断
- overallSentiment 综合所有论点客观判断，不被单一指标主导`;

/**
 * 规则引擎研判（LLM 不可用时降级使用）
 */
function fundamentalExpertRule(
  financial: FinancialData,
  _valuation: ValuationData,
  _info: StockInfo,
): ExpertOpinion {
  const n = financial.years.length;
  const arguments_: ExpertOpinion['arguments'] = [];
  const keyPoints: string[] = [];

  const avgGrossMargin = financial.grossMargin.reduce((a, b) => a + b, 0) / n;
  const grossMarginStability =
    Math.max(...financial.grossMargin) - Math.min(...financial.grossMargin);

  if (avgGrossMargin > 50) {
    arguments_.push({
      text: `平均毛利率${avgGrossMargin.toFixed(1)}%，属于高毛利企业，护城河深厚`,
      confidence: 85,
      type: 'support',
      evidenceType: 'fact',
    });
  } else if (avgGrossMargin > 30) {
    arguments_.push({
      text: `平均毛利率${avgGrossMargin.toFixed(1)}%，盈利能力中等偏上`,
      confidence: 70,
      type: 'support',
      evidenceType: 'fact',
    });
  } else if (avgGrossMargin > 15) {
    arguments_.push({
      text: `平均毛利率${avgGrossMargin.toFixed(1)}%，盈利能力一般`,
      confidence: 60,
      type: 'support',
      evidenceType: 'fact',
    });
  } else {
    arguments_.push({
      text: `平均毛利率仅${avgGrossMargin.toFixed(1)}%，盈利能力偏弱`,
      confidence: 65,
      type: 'oppose',
      evidenceType: 'fact',
    });
  }

  if (grossMarginStability < 3) {
    arguments_.push({
      text: `毛利率波动仅${grossMarginStability.toFixed(1)}个百分点，盈利稳定性极高`,
      confidence: 80,
      type: 'support',
      evidenceType: 'fact',
    });
  } else if (grossMarginStability > 10) {
    arguments_.push({
      text: `毛利率波动达${grossMarginStability.toFixed(1)}个百分点，盈利稳定性较差`,
      confidence: 70,
      type: 'oppose',
      evidenceType: 'fact',
    });
  }

  const avgROE = financial.roe.reduce((a, b) => a + b, 0) / n;
  if (avgROE > 20) {
    arguments_.push({
      text: `平均ROE ${avgROE.toFixed(1)}%，资本回报效率优秀`,
      confidence: 82,
      type: 'support',
      evidenceType: 'fact',
    });
    keyPoints.push(`ROE持续${avgROE.toFixed(0)}%+，资本回报优秀`);
  } else if (avgROE > 10) {
    arguments_.push({
      text: `平均ROE ${avgROE.toFixed(1)}%，资本回报中等`,
      confidence: 65,
      type: 'support',
      evidenceType: 'fact',
    });
  } else {
    arguments_.push({
      text: `平均ROE仅${avgROE.toFixed(1)}%，资本回报效率偏低`,
      confidence: 70,
      type: 'oppose',
      evidenceType: 'fact',
    });
  }

  const cashFlowRatios = financial.operatingCashFlow.map((cf, i) =>
    safeDiv(cf, financial.netProfit[i]),
  );
  const avgCashFlowRatio = cashFlowRatios.reduce((a, b) => a + b, 0) / n;
  if (avgCashFlowRatio > 0.9) {
    arguments_.push({
      text: `经营现金流/净利润均值${avgCashFlowRatio.toFixed(2)}，利润含金量极高`,
      confidence: 88,
      type: 'support',
      evidenceType: 'fact',
    });
    keyPoints.push(`现金流/净利润>${avgCashFlowRatio.toFixed(1)}，盈利质量极高`);
  } else if (avgCashFlowRatio > 0.5) {
    arguments_.push({
      text: `经营现金流/净利润均值${avgCashFlowRatio.toFixed(2)}，利润含金量中等`,
      confidence: 65,
      type: 'support',
      evidenceType: 'fact',
    });
  } else {
    arguments_.push({
      text: `经营现金流/净利润仅${avgCashFlowRatio.toFixed(2)}，利润含金量存疑`,
      confidence: 75,
      type: 'oppose',
      evidenceType: 'fact',
    });
    keyPoints.push(`现金流与利润背离，盈利质量需关注`);
  }

  const arRatio = safeDiv(financial.accountsReceivable[n - 1], financial.revenue[n - 1]) * 100;
  if (arRatio < 5) {
    arguments_.push({
      text: `应收账款占营收仅${arRatio.toFixed(1)}%，回款能力极强`,
      confidence: 78,
      type: 'support',
      evidenceType: 'fact',
    });
  } else if (arRatio > 20) {
    arguments_.push({
      text: `应收账款占营收${arRatio.toFixed(1)}%，需关注回款风险`,
      confidence: 72,
      type: 'oppose',
      evidenceType: 'fact',
    });
  }

  const goodwillRatio = safeDiv(financial.goodwill[n - 1], financial.equity[n - 1]) * 100;
  if (goodwillRatio > 30) {
    arguments_.push({
      text: `商誉/净资产达${goodwillRatio.toFixed(1)}%，存在减值风险`,
      confidence: 80,
      type: 'oppose',
      evidenceType: 'fact',
    });
  } else if (goodwillRatio === 0) {
    arguments_.push({
      text: `零商誉，无减值风险`,
      confidence: 75,
      type: 'support',
      evidenceType: 'fact',
    });
    keyPoints.push(`零商誉，财务稳健`);
  }

  const latestDebtRatio = financial.debtRatio[n - 1];
  if (latestDebtRatio < 30) {
    arguments_.push({
      text: `资产负债率${latestDebtRatio.toFixed(1)}%，财务结构极其稳健`,
      confidence: 80,
      type: 'support',
      evidenceType: 'fact',
    });
    keyPoints.push(`低负债率${latestDebtRatio.toFixed(0)}%，财务极稳健`);
  } else if (latestDebtRatio > 70) {
    arguments_.push({
      text: `资产负债率${latestDebtRatio.toFixed(1)}%，财务杠杆偏高`,
      confidence: 75,
      type: 'oppose',
      evidenceType: 'fact',
    });
  }

  const revenueGrowth =
    safeDiv(financial.revenue[n - 1] - financial.revenue[n - 2], financial.revenue[n - 2]) * 100;
  if (revenueGrowth > 15) {
    arguments_.push({
      text: `最新营收增速${revenueGrowth.toFixed(1)}%，增长强劲`,
      confidence: 75,
      type: 'support',
      evidenceType: 'fact',
    });
  } else if (revenueGrowth < 0) {
    arguments_.push({
      text: `最新营收同比下滑${Math.abs(revenueGrowth).toFixed(1)}%，需关注收入端压力`,
      confidence: 78,
      type: 'oppose',
      evidenceType: 'fact',
    });
  }

  const netMargin = financial.netMargin[n - 1] || 0;
  if (netMargin > 30) keyPoints.push(`净利率${netMargin.toFixed(0)}%，盈利能力顶尖`);
  else if (netMargin > 15) keyPoints.push(`净利率${netMargin.toFixed(0)}%，盈利能力优秀`);
  else if (netMargin > 5) keyPoints.push(`净利率${netMargin.toFixed(0)}%，盈利能力一般`);
  else keyPoints.push(`净利率${netMargin.toFixed(0)}%偏低`);

  if (revenueGrowth > 20) keyPoints.push(`营收增速${revenueGrowth.toFixed(0)}%，高速增长阶段`);
  else if (revenueGrowth > 5) keyPoints.push(`营收增速${revenueGrowth.toFixed(0)}%，稳健增长`);
  else if (revenueGrowth > 0) keyPoints.push(`营收增速${revenueGrowth.toFixed(0)}%，增长放缓`);
  else keyPoints.push(`营收同比下滑${Math.abs(revenueGrowth).toFixed(0)}%，需关注基本面变化`);

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
 * 基本面财务专家
 * LLM 可用时调用 LLM 进行深度研判；不可用或失败时降级规则引擎。
 */
export async function fundamentalExpert(
  financial: FinancialData,
  valuation: ValuationData,
  info: StockInfo,
): Promise<ExpertOpinion> {
  return runExpertWithLLM({
    expertName: EXPERT_NAME,
    systemPrompt: SYSTEM_PROMPT,
    context: formatContext(financial, valuation, info),
    ruleFallback: () => fundamentalExpertRule(financial, valuation, info),
  });
}
