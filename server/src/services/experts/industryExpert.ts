import type { FinancialData, ValuationData, StockInfo, ExpertOpinion } from '../../types.js';

export interface IndustryExpertResult extends ExpertOpinion {
  industryScoreSuggestion: number;
}

export function industryExpert(financial: FinancialData, valuation: ValuationData, info: StockInfo): IndustryExpertResult {
  const n = financial.years.length;
  const arguments_: ExpertOpinion['arguments'] = [];
  const keyPoints: string[] = [];

  // === 营收增速趋势 → 行业周期位置 ===
  const revenueGrowthRates: number[] = [];
  for (let i = 1; i < n; i++) {
    revenueGrowthRates.push((financial.revenue[i] - financial.revenue[i - 1]) / financial.revenue[i - 1] * 100);
  }
  const avgRevenueGrowth = revenueGrowthRates.reduce((a, b) => a + b, 0) / revenueGrowthRates.length;
  const latestRevenueGrowth = revenueGrowthRates[revenueGrowthRates.length - 1];
  const growthTrend = latestRevenueGrowth - avgRevenueGrowth;

  if (avgRevenueGrowth > 15) {
    arguments_.push({ text: `行业平均营收增速${avgRevenueGrowth.toFixed(1)}%，处于高速成长期`, confidence: 78, type: 'support' });
    keyPoints.push(`行业处于高速成长期，平均增速${avgRevenueGrowth.toFixed(0)}%`);
  } else if (avgRevenueGrowth > 5) {
    arguments_.push({ text: `行业平均营收增速${avgRevenueGrowth.toFixed(1)}%，处于稳健增长阶段`, confidence: 70, type: 'support' });
  } else if (avgRevenueGrowth > 0) {
    arguments_.push({ text: `行业平均营收增速仅${avgRevenueGrowth.toFixed(1)}%，行业进入低增长或成熟期`, confidence: 68, type: 'oppose' });
    keyPoints.push(`行业增速放缓至${avgRevenueGrowth.toFixed(1)}%，进入成熟期`);
  } else {
    arguments_.push({ text: `行业平均营收增速${avgRevenueGrowth.toFixed(1)}%，行业整体收缩`, confidence: 75, type: 'oppose' });
    keyPoints.push(`行业整体收缩，平均增速${avgRevenueGrowth.toFixed(1)}%`);
  }

  // 增速趋势判断
  if (growthTrend > 5) {
    arguments_.push({ text: `最新营收增速${latestRevenueGrowth.toFixed(1)}%高于均值${avgRevenueGrowth.toFixed(1)}%，行业景气度回升`, confidence: 72, type: 'support' });
  } else if (growthTrend < -5) {
    arguments_.push({ text: `最新营收增速${latestRevenueGrowth.toFixed(1)}%低于均值${avgRevenueGrowth.toFixed(1)}%，行业景气度下行`, confidence: 75, type: 'oppose' });
    keyPoints.push(`行业景气度下行，增速趋势走弱`);
  }

  // === 毛利率趋势 → 竞争格局变化 ===
  const grossMarginTrend = financial.grossMargin[n - 1] - financial.grossMargin[0];
  const avgGrossMargin = financial.grossMargin.reduce((a, b) => a + b, 0) / n;

  if (grossMarginTrend > 3) {
    arguments_.push({ text: `毛利率${financial.grossMargin[0].toFixed(1)}%→${financial.grossMargin[n - 1].toFixed(1)}%，呈上升趋势，行业竞争格局改善或定价权增强`, confidence: 75, type: 'support' });
  } else if (grossMarginTrend < -3) {
    arguments_.push({ text: `毛利率${financial.grossMargin[0].toFixed(1)}%→${financial.grossMargin[n - 1].toFixed(1)}%，呈下降趋势，行业竞争加剧或成本压力上升`, confidence: 75, type: 'oppose' });
    keyPoints.push(`毛利率趋势下行${grossMarginTrend.toFixed(1)}个百分点，竞争加剧`);
  } else {
    arguments_.push({ text: `毛利率波动仅${grossMarginTrend.toFixed(1)}个百分点，行业竞争格局稳定`, confidence: 68, type: 'support' });
  }

  // === 同业公司表现对比 → 行业集中度 ===
  if (valuation.peerComparison.length > 0) {
    const totalPeerCap = valuation.peerComparison.reduce((s, p) => s + p.marketCap, 0);
    const companyShare = valuation.marketCap / (valuation.marketCap + totalPeerCap) * 100;
    const topPeerShare = Math.max(...valuation.peerComparison.map(p => p.marketCap)) / (valuation.marketCap + totalPeerCap) * 100;
    const concentrationRatio = companyShare + topPeerShare;

    if (concentrationRatio > 60) {
      arguments_.push({ text: `行业集中度高（前两大市值占比${concentrationRatio.toFixed(0)}%），龙头格局清晰，马太效应显著`, confidence: 78, type: 'support' });
      keyPoints.push(`行业集中度高，龙头优势显著`);
    } else if (concentrationRatio > 40) {
      arguments_.push({ text: `行业集中度中等（前两大市值占比${concentrationRatio.toFixed(0)}%），竞争格局尚可`, confidence: 65, type: 'support' });
    } else {
      arguments_.push({ text: `行业集中度较低（前两大市值占比${concentrationRatio.toFixed(0)}%），竞争分散`, confidence: 68, type: 'oppose' });
    }

    // 同业增速对比
    const peerAvgROE = valuation.peerComparison.reduce((s, p) => s + p.roe, 0) / valuation.peerComparison.length;
    const avgROE = financial.roe.reduce((a, b) => a + b, 0) / n;
    if (avgROE > peerAvgROE * 1.3) {
      arguments_.push({ text: `ROE ${avgROE.toFixed(1)}%显著领先同业均值${peerAvgROE.toFixed(1)}%，竞争优势突出`, confidence: 80, type: 'support' });
    } else if (avgROE < peerAvgROE * 0.7) {
      arguments_.push({ text: `ROE ${avgROE.toFixed(1)}%低于同业均值${peerAvgROE.toFixed(1)}%，竞争力不足`, confidence: 72, type: 'oppose' });
    }
  }

  // === 行业景气度评分建议 (0-20) ===
  let industryScoreSuggestion = 10; // 基础分

  // 基于增速调整 (-5 ~ +5)
  if (avgRevenueGrowth > 15) industryScoreSuggestion += 5;
  else if (avgRevenueGrowth > 10) industryScoreSuggestion += 4;
  else if (avgRevenueGrowth > 5) industryScoreSuggestion += 3;
  else if (avgRevenueGrowth > 0) industryScoreSuggestion += 1;
  else industryScoreSuggestion -= 3;

  // 基于景气趋势调整 (-2 ~ +2)
  if (growthTrend > 5) industryScoreSuggestion += 2;
  else if (growthTrend < -5) industryScoreSuggestion -= 2;

  // 基于毛利率趋势调整 (-2 ~ +2)
  if (grossMarginTrend > 3) industryScoreSuggestion += 2;
  else if (grossMarginTrend < -3) industryScoreSuggestion -= 2;

  industryScoreSuggestion = Math.max(0, Math.min(20, industryScoreSuggestion));

  // 确定整体情绪
  const supportCount = arguments_.filter(a => a.type === 'support').length;
  const opposeCount = arguments_.filter(a => a.type === 'oppose').length;
  let overallSentiment: 'bullish' | 'neutral' | 'bearish' = 'neutral';
  if (supportCount > opposeCount + 2) overallSentiment = 'bullish';
  else if (opposeCount > supportCount + 2) overallSentiment = 'bearish';

  const avgConfidence = Math.round(arguments_.reduce((s, a) => s + a.confidence, 0) / arguments_.length);

  keyPoints.push(`行业景气度评分建议：${industryScoreSuggestion}/20`);

  return {
    expert: '行业宏观专家',
    arguments: arguments_,
    overallSentiment,
    confidence: avgConfidence,
    keyPoints: keyPoints.slice(0, 6),
    industryScoreSuggestion
  };
}
