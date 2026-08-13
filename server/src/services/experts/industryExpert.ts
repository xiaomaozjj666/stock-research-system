import type { FinancialData, ValuationData, StockInfo, ExpertOpinion } from '../../types.js';
import { safeDiv } from '../safeDiv.js';
import { runExpertWithLLM } from '../../llm/expertRunner.js';
import { formatContext } from '../../llm/prompts.js';

export interface IndustryExpertResult extends ExpertOpinion {
  industryScoreSuggestion: number;
}

const EXPERT_NAME = '行业宏观专家';

const SYSTEM_PROMPT = `你是资深行业宏观分析师，专注 A 股行业景气度与竞争格局研判，拥有 12 年行业研究经验。
分析维度：行业生命周期位置（成长/成熟/衰退）、营收增速趋势（景气度方向）、
毛利率趋势（竞争格局变化）、行业集中度、同业竞争对比。
要求：
- 从财务数据间接推断行业景气度（无行业政策等外部数据时明确标注推断性质）
- 区分公司个体因素与行业整体趋势
- 既要看到行业机会也要看到结构性风险`;

/**
 * 行业景气度量化评分（0-20）
 * 量化评分始终用规则计算，确定性高，不交给 LLM（LLM 不擅长精确打分）
 */
function calcIndustryScore(financial: FinancialData): number {
  const n = financial.years.length;
  const revenueGrowthRates: number[] = [];
  for (let i = 1; i < n; i++) {
    revenueGrowthRates.push(
      safeDiv(financial.revenue[i] - financial.revenue[i - 1], financial.revenue[i - 1]) * 100,
    );
  }
  const avgRevenueGrowth =
    revenueGrowthRates.length > 0
      ? revenueGrowthRates.reduce((a, b) => a + b, 0) / revenueGrowthRates.length
      : 0;
  const latestRevenueGrowth = revenueGrowthRates[revenueGrowthRates.length - 1] ?? 0;
  const growthTrend = latestRevenueGrowth - avgRevenueGrowth;
  const grossMarginTrend = financial.grossMargin[n - 1] - financial.grossMargin[0];

  let score = 10; // 基础分
  if (avgRevenueGrowth > 15) score += 5;
  else if (avgRevenueGrowth > 10) score += 4;
  else if (avgRevenueGrowth > 5) score += 3;
  else if (avgRevenueGrowth > 0) score += 1;
  else score -= 3;

  if (growthTrend > 5) score += 2;
  else if (growthTrend < -5) score -= 2;

  if (grossMarginTrend > 3) score += 2;
  else if (grossMarginTrend < -3) score -= 2;

  return Math.max(0, Math.min(20, score));
}

/**
 * 规则引擎研判（LLM 不可用时降级使用）
 */
function industryExpertRule(
  financial: FinancialData,
  valuation: ValuationData,
  _info: StockInfo,
): IndustryExpertResult {
  const n = financial.years.length;
  const arguments_: ExpertOpinion['arguments'] = [];
  const keyPoints: string[] = [];

  const revenueGrowthRates: number[] = [];
  for (let i = 1; i < n; i++) {
    revenueGrowthRates.push(
      safeDiv(financial.revenue[i] - financial.revenue[i - 1], financial.revenue[i - 1]) * 100,
    );
  }
  const avgRevenueGrowth =
    revenueGrowthRates.reduce((a, b) => a + b, 0) / revenueGrowthRates.length;
  const latestRevenueGrowth = revenueGrowthRates[revenueGrowthRates.length - 1];
  const growthTrend = latestRevenueGrowth - avgRevenueGrowth;

  if (avgRevenueGrowth > 15) {
    arguments_.push({
      text: `行业平均营收增速${avgRevenueGrowth.toFixed(1)}%，处于高速成长期`,
      confidence: 78,
      type: 'support',
      evidenceType: 'inference',
    });
    keyPoints.push(`行业处于高速成长期，平均增速${avgRevenueGrowth.toFixed(0)}%`);
  } else if (avgRevenueGrowth > 5) {
    arguments_.push({
      text: `行业平均营收增速${avgRevenueGrowth.toFixed(1)}%，处于稳健增长阶段`,
      confidence: 70,
      type: 'support',
      evidenceType: 'inference',
    });
  } else if (avgRevenueGrowth > 0) {
    arguments_.push({
      text: `行业平均营收增速仅${avgRevenueGrowth.toFixed(1)}%，行业进入低增长或成熟期`,
      confidence: 68,
      type: 'oppose',
      evidenceType: 'inference',
    });
    keyPoints.push(`行业增速放缓至${avgRevenueGrowth.toFixed(1)}%，进入成熟期`);
  } else {
    arguments_.push({
      text: `行业平均营收增速${avgRevenueGrowth.toFixed(1)}%，行业整体收缩`,
      confidence: 75,
      type: 'oppose',
      evidenceType: 'inference',
    });
    keyPoints.push(`行业整体收缩，平均增速${avgRevenueGrowth.toFixed(1)}%`);
  }

  if (growthTrend > 5) {
    arguments_.push({
      text: `最新营收增速${latestRevenueGrowth.toFixed(1)}%高于均值${avgRevenueGrowth.toFixed(1)}%，行业景气度回升`,
      confidence: 72,
      type: 'support',
      evidenceType: 'inference',
    });
  } else if (growthTrend < -5) {
    arguments_.push({
      text: `最新营收增速${latestRevenueGrowth.toFixed(1)}%低于均值${avgRevenueGrowth.toFixed(1)}%，行业景气度下行`,
      confidence: 75,
      type: 'oppose',
      evidenceType: 'inference',
    });
    keyPoints.push(`行业景气度下行，增速趋势走弱`);
  }

  const grossMarginTrend = financial.grossMargin[n - 1] - financial.grossMargin[0];

  if (grossMarginTrend > 3) {
    arguments_.push({
      text: `毛利率${financial.grossMargin[0].toFixed(1)}%→${financial.grossMargin[n - 1].toFixed(1)}%，呈上升趋势，行业竞争格局改善或定价权增强`,
      confidence: 75,
      type: 'support',
      evidenceType: 'inference',
    });
  } else if (grossMarginTrend < -3) {
    arguments_.push({
      text: `毛利率${financial.grossMargin[0].toFixed(1)}%→${financial.grossMargin[n - 1].toFixed(1)}%，呈下降趋势，行业竞争加剧或成本压力上升`,
      confidence: 75,
      type: 'oppose',
      evidenceType: 'inference',
    });
    keyPoints.push(`毛利率趋势下行${grossMarginTrend.toFixed(1)}个百分点，竞争加剧`);
  } else {
    arguments_.push({
      text: `毛利率波动仅${grossMarginTrend.toFixed(1)}个百分点，行业竞争格局稳定`,
      confidence: 68,
      type: 'support',
      evidenceType: 'inference',
    });
  }

  if (valuation.peerComparison.length > 0) {
    const totalPeerCap = valuation.peerComparison.reduce((s, p) => s + p.marketCap, 0);
    const companyShare = safeDiv(valuation.marketCap, valuation.marketCap + totalPeerCap) * 100;
    const topPeerShare =
      safeDiv(
        Math.max(...valuation.peerComparison.map((p) => p.marketCap)),
        valuation.marketCap + totalPeerCap,
      ) * 100;
    const concentrationRatio = companyShare + topPeerShare;

    if (concentrationRatio > 60) {
      arguments_.push({
        text: `行业集中度高（前两大市值占比${concentrationRatio.toFixed(0)}%），龙头格局清晰，马太效应显著`,
        confidence: 78,
        type: 'support',
        evidenceType: 'inference',
      });
      keyPoints.push(`行业集中度高，龙头优势显著`);
    } else if (concentrationRatio > 40) {
      arguments_.push({
        text: `行业集中度中等（前两大市值占比${concentrationRatio.toFixed(0)}%），竞争格局尚可`,
        confidence: 65,
        type: 'support',
        evidenceType: 'inference',
      });
    } else {
      arguments_.push({
        text: `行业集中度较低（前两大市值占比${concentrationRatio.toFixed(0)}%），竞争分散`,
        confidence: 68,
        type: 'oppose',
        evidenceType: 'inference',
      });
    }

    // ROE 同业对比需同业 ROE 数据可用（当前行情接口未提供同业 ROE，全为0时跳过，避免误判"领先同业"）
    const hasPeerRoe = valuation.peerComparison.some((p) => p.roe > 0);
    if (hasPeerRoe) {
      const peerAvgROE = safeDiv(
        valuation.peerComparison.reduce((s, p) => s + p.roe, 0),
        valuation.peerComparison.length,
      );
      const avgROE = financial.roe.reduce((a, b) => a + b, 0) / n;
      if (avgROE > peerAvgROE * 1.3) {
        arguments_.push({
          text: `ROE ${avgROE.toFixed(1)}%显著领先同业均值${peerAvgROE.toFixed(1)}%，竞争优势突出`,
          confidence: 80,
          type: 'support',
          evidenceType: 'fact',
        });
      } else if (avgROE < peerAvgROE * 0.7) {
        arguments_.push({
          text: `ROE ${avgROE.toFixed(1)}%低于同业均值${peerAvgROE.toFixed(1)}%，竞争力不足`,
          confidence: 72,
          type: 'oppose',
          evidenceType: 'fact',
        });
      }
    }
  }

  const industryScoreSuggestion = calcIndustryScore(financial);

  const supportCount = arguments_.filter((a) => a.type === 'support').length;
  const opposeCount = arguments_.filter((a) => a.type === 'oppose').length;
  let overallSentiment: 'bullish' | 'neutral' | 'bearish' = 'neutral';
  if (supportCount > opposeCount + 2) overallSentiment = 'bullish';
  else if (opposeCount > supportCount + 2) overallSentiment = 'bearish';

  const avgConfidence = Math.round(
    arguments_.reduce((s, a) => s + a.confidence, 0) / arguments_.length,
  );

  keyPoints.push(`行业景气度评分建议：${industryScoreSuggestion}/20`);

  return {
    expert: EXPERT_NAME,
    arguments: arguments_,
    overallSentiment,
    confidence: avgConfidence,
    keyPoints: keyPoints.slice(0, 6),
    industryScoreSuggestion,
  };
}

/**
 * 行业宏观专家
 * LLM 可用时调用 LLM 进行深度行业研判；不可用或失败时降级规则引擎。
 * 行业景气度量化评分（industryScoreSuggestion）始终用规则计算，保证确定性。
 */
export async function industryExpert(
  financial: FinancialData,
  valuation: ValuationData,
  info: StockInfo,
): Promise<IndustryExpertResult> {
  const opinion = await runExpertWithLLM({
    expertName: EXPERT_NAME,
    systemPrompt: SYSTEM_PROMPT,
    context: formatContext(financial, valuation, info),
    ruleFallback: () => industryExpertRule(financial, valuation, info),
  });
  // 量化评分始终用规则计算（LLM 不擅长精确打分，规则确定性更高）
  return { ...opinion, industryScoreSuggestion: calcIndustryScore(financial) };
}
