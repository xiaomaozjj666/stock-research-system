import type { FinancialData, ValuationData, StockInfo, ExpertOpinion } from '../../types.js';

export function riskExpert(financial: FinancialData, valuation: ValuationData, info: StockInfo): ExpertOpinion {
  const n = financial.years.length;
  const arguments_: ExpertOpinion['arguments'] = [];
  const keyPoints: string[] = [];

  // === 应收账款暴增检查（应收增速 vs 营收增速） ===
  const arGrowth = n >= 2 ? (financial.accountsReceivable[n - 1] - financial.accountsReceivable[n - 2]) / Math.abs(financial.accountsReceivable[n - 2]) * 100 : 0;
  const revenueGrowth = n >= 2 ? (financial.revenue[n - 1] - financial.revenue[n - 2]) / financial.revenue[n - 2] * 100 : 0;
  const arRatio = financial.accountsReceivable[n - 1] / financial.revenue[n - 1] * 100;

  if (arGrowth > revenueGrowth + 30 && arGrowth > 20) {
    arguments_.push({ text: `应收账款增速${arGrowth.toFixed(1)}%远超营收增速${revenueGrowth.toFixed(1)}%，存在虚增收入或回款恶化风险`, confidence: 82, type: 'oppose' });
    keyPoints.push(`应收增速${arGrowth.toFixed(0)}%远超营收${revenueGrowth.toFixed(0)}%，回款异常`);
  } else if (arRatio < 3) {
    arguments_.push({ text: `应收账款占营收仅${arRatio.toFixed(1)}%，坏账风险极低`, confidence: 80, type: 'support' });
    keyPoints.push(`应收占营收${arRatio.toFixed(1)}%，回款能力极强`);
  } else if (arRatio > 20) {
    arguments_.push({ text: `应收账款占营收${arRatio.toFixed(1)}%，信用风险敞口较大`, confidence: 75, type: 'oppose' });
    keyPoints.push(`应收占营收${arRatio.toFixed(1)}%，回款风险偏高`);
  }

  // === 存货异常检查（存货增速 vs 营收增速） ===
  const inventoryGrowth = n >= 2 ? (financial.inventory[n - 1] - financial.inventory[n - 2]) / Math.abs(financial.inventory[n - 2]) * 100 : 0;

  if (inventoryGrowth > revenueGrowth + 30 && inventoryGrowth > 20) {
    arguments_.push({ text: `存货增速${inventoryGrowth.toFixed(1)}%远超营收增速${revenueGrowth.toFixed(1)}%，存在积压或减值风险`, confidence: 78, type: 'oppose' });
    keyPoints.push(`存货增速${inventoryGrowth.toFixed(0)}%远超营收，积压风险`);
  } else if (inventoryGrowth < 0 && revenueGrowth > 0) {
    arguments_.push({ text: `存货同比下降${Math.abs(inventoryGrowth).toFixed(1)}%而营收增长，库存去化健康`, confidence: 72, type: 'support' });
  }

  // === 现金流与利润背离检查 ===
  const cashFlowRatios = financial.operatingCashFlow.map((cf, i) => cf / financial.netProfit[i]);
  const avgCashFlowRatio = cashFlowRatios.reduce((a, b) => a + b, 0) / n;
  const latestCashFlowRatio = cashFlowRatios[n - 1];

  if (avgCashFlowRatio < 0.3) {
    arguments_.push({ text: `经营现金流/净利润均值仅${avgCashFlowRatio.toFixed(2)}，利润含金量严重不足`, confidence: 85, type: 'oppose' });
    keyPoints.push(`现金流/净利润${avgCashFlowRatio.toFixed(2)}，利润含金量差`);
  } else if (latestCashFlowRatio < 0 && avgCashFlowRatio > 0.5) {
    arguments_.push({ text: `最新年度现金流/净利润转负（${latestCashFlowRatio.toFixed(2)}），盈利质量出现恶化信号`, confidence: 78, type: 'oppose' });
  } else if (avgCashFlowRatio > 0.9) {
    arguments_.push({ text: `经营现金流/净利润均值${avgCashFlowRatio.toFixed(2)}，利润含金量高`, confidence: 78, type: 'support' });
  }

  // === 商誉减值风险 ===
  const goodwillRatio = financial.goodwill[n - 1] / financial.equity[n - 1] * 100;
  if (goodwillRatio > 50) {
    arguments_.push({ text: `商誉/净资产达${goodwillRatio.toFixed(1)}%，减值风险极高`, confidence: 88, type: 'oppose' });
    keyPoints.push(`商誉/净资产${goodwillRatio.toFixed(0)}%，减值风险极高`);
  } else if (goodwillRatio > 20) {
    arguments_.push({ text: `商誉/净资产${goodwillRatio.toFixed(1)}%，存在一定减值风险`, confidence: 75, type: 'oppose' });
  } else if (goodwillRatio === 0) {
    arguments_.push({ text: `零商誉，无减值风险`, confidence: 75, type: 'support' });
    keyPoints.push(`零商誉，无减值风险`);
  }

  // === 高负债率风险 ===
  const latestDebtRatio = financial.debtRatio[n - 1];
  const debtTrend = financial.debtRatio[n - 1] - financial.debtRatio[0];

  if (latestDebtRatio > 80) {
    arguments_.push({ text: `资产负债率${latestDebtRatio.toFixed(1)}%，财务风险极高`, confidence: 85, type: 'oppose' });
    keyPoints.push(`负债率${latestDebtRatio.toFixed(0)}%，财务风险极高`);
  } else if (latestDebtRatio > 60 && debtTrend > 5) {
    arguments_.push({ text: `资产负债率${latestDebtRatio.toFixed(1)}%且逐年上升（+${debtTrend.toFixed(1)}个百分点），杠杆持续加大`, confidence: 78, type: 'oppose' });
    keyPoints.push(`负债率上升中，杠杆加大`);
  } else if (latestDebtRatio < 30) {
    arguments_.push({ text: `资产负债率${latestDebtRatio.toFixed(1)}%，财务安全垫厚实`, confidence: 78, type: 'support' });
    keyPoints.push(`低负债率${latestDebtRatio.toFixed(0)}%，财务稳健`);
  }

  // === 股权质押风险（基于数据可用性判断） ===
  // 注：当前 FinancialData 中无质押数据，仅做占位逻辑
  // 如未来数据扩展可加入质押比例检查

  // === 综合风险等级评估 ===
  const opposeCount = arguments_.filter(a => a.type === 'oppose').length;
  const supportCount = arguments_.filter(a => a.type === 'support').length;

  let overallSentiment: 'bullish' | 'neutral' | 'bearish';
  if (opposeCount <= 1 && supportCount >= 3) {
    overallSentiment = 'bullish'; // 风险很低
  } else if (opposeCount >= 3) {
    overallSentiment = 'bearish'; // 风险较高
  } else {
    overallSentiment = 'neutral';
  }

  const avgConfidence = Math.round(arguments_.reduce((s, a) => s + a.confidence, 0) / arguments_.length);

  return {
    expert: '风险合规专家',
    arguments: arguments_,
    overallSentiment,
    confidence: avgConfidence,
    keyPoints: keyPoints.slice(0, 6)
  };
}
