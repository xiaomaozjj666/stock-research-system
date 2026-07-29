import type { FinancialData, ValuationData, StockInfo, ExpertOpinion } from '../../types.js';

export function valuationExpert(financial: FinancialData, valuation: ValuationData, _info: StockInfo): ExpertOpinion {
  const n = financial.years.length;
  const arguments_: ExpertOpinion['arguments'] = [];
  const keyPoints: string[] = [];

  // === PE 历史分位分析 ===
  const peValues = valuation.historicalPE.map(h => h.pe).sort((a, b) => a - b);
  const currentPE = valuation.pe;
  const pePercentile = (peValues.filter(p => p <= currentPE).length / peValues.length) * 100;

  if (pePercentile <= 20) {
    arguments_.push({ text: `当前PE ${currentPE}x处于近${peValues.length}年历史${pePercentile.toFixed(0)}%分位，估值处于历史低位，安全边际较高`, confidence: 82, type: 'support' });
    keyPoints.push(`PE ${currentPE}x处于历史${pePercentile.toFixed(0)}%分位，低估`);
  } else if (pePercentile <= 40) {
    arguments_.push({ text: `当前PE ${currentPE}x处于近${peValues.length}年历史${pePercentile.toFixed(0)}%分位，估值偏低`, confidence: 72, type: 'support' });
  } else if (pePercentile <= 60) {
    arguments_.push({ text: `当前PE ${currentPE}x处于近${peValues.length}年历史${pePercentile.toFixed(0)}%分位，估值合理`, confidence: 65, type: 'support' });
  } else if (pePercentile <= 80) {
    arguments_.push({ text: `当前PE ${currentPE}x处于近${peValues.length}年历史${pePercentile.toFixed(0)}%分位，估值偏高`, confidence: 72, type: 'oppose' });
  } else {
    arguments_.push({ text: `当前PE ${currentPE}x处于近${peValues.length}年历史${pePercentile.toFixed(0)}%分位，估值处于历史高位`, confidence: 80, type: 'oppose' });
    keyPoints.push(`PE ${currentPE}x处于历史${pePercentile.toFixed(0)}%分位，高估`);
  }

  // === 同业 PE 对比 ===
  const peerAvgPE = valuation.peerComparison.reduce((s, p) => s + p.pe, 0) / valuation.peerComparison.length;
  const pePremium = (currentPE / peerAvgPE - 1) * 100;

  if (pePremium > 30) {
    arguments_.push({ text: `PE较同业均值${peerAvgPE.toFixed(1)}x溢价${pePremium.toFixed(0)}%，估值偏高，需高增长支撑`, confidence: 72, type: 'oppose' });
  } else if (pePremium > 0) {
    arguments_.push({ text: `PE较同业均值${peerAvgPE.toFixed(1)}x溢价${pePremium.toFixed(0)}%，存在一定龙头溢价`, confidence: 60, type: 'support' });
  } else {
    arguments_.push({ text: `PE较同业均值${peerAvgPE.toFixed(1)}x折价${Math.abs(pePremium).toFixed(0)}%，估值相对便宜`, confidence: 75, type: 'support' });
    keyPoints.push(`PE相对同业折价${Math.abs(pePremium).toFixed(0)}%，估值偏低`);
  }

  // === PEG 分析（处理负增长） ===
  const latestProfitGrowth = (financial.netProfit[n - 1] - financial.netProfit[n - 2]) / financial.netProfit[n - 2] * 100;

  if (latestProfitGrowth <= 0) {
    arguments_.push({ text: `净利润同比下滑${Math.abs(latestProfitGrowth).toFixed(1)}%，PEG失效，估值与增长脱钩，需警惕`, confidence: 78, type: 'oppose' });
    keyPoints.push(`利润负增长${latestProfitGrowth.toFixed(1)}%，PEG失效`);
  } else {
    const peg = currentPE / latestProfitGrowth;
    if (peg < 0.8) {
      arguments_.push({ text: `PEG约${peg.toFixed(2)}，显著低于1，估值与增速匹配度高，性价比突出`, confidence: 80, type: 'support' });
      keyPoints.push(`PEG ${peg.toFixed(2)}，估值与增速匹配`);
    } else if (peg < 1.2) {
      arguments_.push({ text: `PEG约${peg.toFixed(2)}，估值与增速基本匹配`, confidence: 68, type: 'support' });
    } else if (peg < 2.0) {
      arguments_.push({ text: `PEG约${peg.toFixed(2)}，估值相对增速偏高`, confidence: 70, type: 'oppose' });
    } else {
      arguments_.push({ text: `PEG约${peg.toFixed(2)}，估值显著高于增速，泡沫风险较大`, confidence: 78, type: 'oppose' });
    }
  }

  // === PB-ROE 匹配度分析 ===
  const avgROE = financial.roe.reduce((a, b) => a + b, 0) / n;
  const peerAvgROE = valuation.peerComparison.length > 0
    ? valuation.peerComparison.reduce((s, p) => s + p.roe, 0) / valuation.peerComparison.length
    : avgROE;
  const pbRoeRatio = valuation.pb / (avgROE / 100); // PB除以ROE(小数形式)

  if (avgROE > peerAvgROE * 1.2 && pbRoeRatio < 3) {
    arguments_.push({ text: `ROE ${avgROE.toFixed(1)}%领先同业，PB/ROE比值${pbRoeRatio.toFixed(1)}，资本效率与估值匹配度好`, confidence: 75, type: 'support' });
  } else if (pbRoeRatio > 5) {
    arguments_.push({ text: `PB/ROE比值${pbRoeRatio.toFixed(1)}偏高，估值相对资本回报存在溢价过度`, confidence: 72, type: 'oppose' });
  }

  // === 利润增速趋势 ===
  if (n >= 3) {
    const prevGrowth = (financial.netProfit[n - 2] - financial.netProfit[n - 3]) / financial.netProfit[n - 3] * 100;
    if (latestProfitGrowth > 15 && latestProfitGrowth > prevGrowth) {
      arguments_.push({ text: `利润增速${latestProfitGrowth.toFixed(1)}%加速增长（前值${prevGrowth.toFixed(1)}%），增长动能增强`, confidence: 75, type: 'support' });
    } else if (latestProfitGrowth < prevGrowth - 10) {
      arguments_.push({ text: `利润增速从${prevGrowth.toFixed(1)}%降至${latestProfitGrowth.toFixed(1)}%，增速放缓明显`, confidence: 75, type: 'oppose' });
      keyPoints.push(`利润增速放缓，增长动能减弱`);
    }
  }

  // 确定整体情绪
  const supportCount = arguments_.filter(a => a.type === 'support').length;
  const opposeCount = arguments_.filter(a => a.type === 'oppose').length;
  let overallSentiment: 'bullish' | 'neutral' | 'bearish' = 'neutral';
  if (supportCount > opposeCount + 2) overallSentiment = 'bullish';
  else if (opposeCount > supportCount + 2) overallSentiment = 'bearish';

  const avgConfidence = Math.round(arguments_.reduce((s, a) => s + a.confidence, 0) / arguments_.length);

  return {
    expert: '估值建模专家',
    arguments: arguments_,
    overallSentiment,
    confidence: avgConfidence,
    keyPoints: keyPoints.slice(0, 6)
  };
}
