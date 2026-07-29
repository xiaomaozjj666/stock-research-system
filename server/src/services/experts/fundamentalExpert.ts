import type { FinancialData, ValuationData, StockInfo, ExpertOpinion } from '../../types.js';

export function fundamentalExpert(financial: FinancialData, _valuation: ValuationData, _info: StockInfo): ExpertOpinion {
  const n = financial.years.length;
  const arguments_: ExpertOpinion['arguments'] = [];
  const keyPoints: string[] = [];

  // === 毛利率分析 ===
  const avgGrossMargin = financial.grossMargin.reduce((a, b) => a + b, 0) / n;
  const grossMarginStability = Math.max(...financial.grossMargin) - Math.min(...financial.grossMargin);

  if (avgGrossMargin > 50) {
    arguments_.push({ text: `平均毛利率${avgGrossMargin.toFixed(1)}%，属于高毛利企业，护城河深厚`, confidence: 85, type: 'support' });
  } else if (avgGrossMargin > 30) {
    arguments_.push({ text: `平均毛利率${avgGrossMargin.toFixed(1)}%，盈利能力中等偏上`, confidence: 70, type: 'support' });
  } else if (avgGrossMargin > 15) {
    arguments_.push({ text: `平均毛利率${avgGrossMargin.toFixed(1)}%，盈利能力一般`, confidence: 60, type: 'support' });
  } else {
    arguments_.push({ text: `平均毛利率仅${avgGrossMargin.toFixed(1)}%，盈利能力偏弱`, confidence: 65, type: 'oppose' });
  }

  if (grossMarginStability < 3) {
    arguments_.push({ text: `毛利率波动仅${grossMarginStability.toFixed(1)}个百分点，盈利稳定性极高`, confidence: 80, type: 'support' });
  } else if (grossMarginStability > 10) {
    arguments_.push({ text: `毛利率波动达${grossMarginStability.toFixed(1)}个百分点，盈利稳定性较差`, confidence: 70, type: 'oppose' });
  }

  // === ROE 分析 ===
  const avgROE = financial.roe.reduce((a, b) => a + b, 0) / n;
  if (avgROE > 20) {
    arguments_.push({ text: `平均ROE ${avgROE.toFixed(1)}%，资本回报效率优秀`, confidence: 82, type: 'support' });
    keyPoints.push(`ROE持续${avgROE.toFixed(0)}%+，资本回报优秀`);
  } else if (avgROE > 10) {
    arguments_.push({ text: `平均ROE ${avgROE.toFixed(1)}%，资本回报中等`, confidence: 65, type: 'support' });
  } else {
    arguments_.push({ text: `平均ROE仅${avgROE.toFixed(1)}%，资本回报效率偏低`, confidence: 70, type: 'oppose' });
  }

  // === 现金流质量分析 ===
  const cashFlowRatios = financial.operatingCashFlow.map((cf, i) => cf / financial.netProfit[i]);
  const avgCashFlowRatio = cashFlowRatios.reduce((a, b) => a + b, 0) / n;
  if (avgCashFlowRatio > 0.9) {
    arguments_.push({ text: `经营现金流/净利润均值${avgCashFlowRatio.toFixed(2)}，利润含金量极高`, confidence: 88, type: 'support' });
    keyPoints.push(`现金流/净利润>${avgCashFlowRatio.toFixed(1)}，盈利质量极高`);
  } else if (avgCashFlowRatio > 0.5) {
    arguments_.push({ text: `经营现金流/净利润均值${avgCashFlowRatio.toFixed(2)}，利润含金量中等`, confidence: 65, type: 'support' });
  } else {
    arguments_.push({ text: `经营现金流/净利润仅${avgCashFlowRatio.toFixed(2)}，利润含金量存疑`, confidence: 75, type: 'oppose' });
    keyPoints.push(`现金流与利润背离，盈利质量需关注`);
  }

  // === 应收账款异常检查 ===
  const arRatio = financial.accountsReceivable[n - 1] / financial.revenue[n - 1] * 100;
  if (arRatio < 5) {
    arguments_.push({ text: `应收账款占营收仅${arRatio.toFixed(1)}%，回款能力极强`, confidence: 78, type: 'support' });
  } else if (arRatio > 20) {
    arguments_.push({ text: `应收账款占营收${arRatio.toFixed(1)}%，需关注回款风险`, confidence: 72, type: 'oppose' });
  }

  // === 商誉风险检查 ===
  const goodwillRatio = financial.goodwill[n - 1] / financial.equity[n - 1] * 100;
  if (goodwillRatio > 30) {
    arguments_.push({ text: `商誉/净资产达${goodwillRatio.toFixed(1)}%，存在减值风险`, confidence: 80, type: 'oppose' });
  } else if (goodwillRatio === 0) {
    arguments_.push({ text: `零商誉，无减值风险`, confidence: 75, type: 'support' });
    keyPoints.push(`零商誉，财务稳健`);
  }

  // === 资产负债率分析 ===
  const latestDebtRatio = financial.debtRatio[n - 1];
  if (latestDebtRatio < 30) {
    arguments_.push({ text: `资产负债率${latestDebtRatio.toFixed(1)}%，财务结构极其稳健`, confidence: 80, type: 'support' });
    keyPoints.push(`低负债率${latestDebtRatio.toFixed(0)}%，财务极稳健`);
  } else if (latestDebtRatio > 70) {
    arguments_.push({ text: `资产负债率${latestDebtRatio.toFixed(1)}%，财务杠杆偏高`, confidence: 75, type: 'oppose' });
  }

  // === 营收增长趋势 ===
  const revenueGrowth = (financial.revenue[n - 1] - financial.revenue[n - 2]) / financial.revenue[n - 2] * 100;
  if (revenueGrowth > 15) {
    arguments_.push({ text: `最新营收增速${revenueGrowth.toFixed(1)}%，增长强劲`, confidence: 75, type: 'support' });
  } else if (revenueGrowth < 0) {
    arguments_.push({ text: `最新营收同比下滑${Math.abs(revenueGrowth).toFixed(1)}%，需关注收入端压力`, confidence: 78, type: 'oppose' });
  }

  // 确定整体情绪
  const supportCount = arguments_.filter(a => a.type === 'support').length;
  const opposeCount = arguments_.filter(a => a.type === 'oppose').length;
  let overallSentiment: 'bullish' | 'neutral' | 'bearish' = 'neutral';
  if (supportCount > opposeCount + 2) overallSentiment = 'bullish';
  else if (opposeCount > supportCount + 2) overallSentiment = 'bearish';

  const avgConfidence = Math.round(arguments_.reduce((s, a) => s + a.confidence, 0) / arguments_.length);

  return {
    expert: '基本面财务专家',
    arguments: arguments_,
    overallSentiment,
    confidence: avgConfidence,
    keyPoints: keyPoints.slice(0, 6)
  };
}
