import { runExpertWithLLM } from '../../llm/expertRunner.js';
import { formatContext } from '../../llm/prompts.js';
import type { ExpertOpinion, FinancialData, StockInfo, ValuationData } from '../../types.js';
import { safeDiv } from '../safeDiv.js';
import { hasEstimatedHistoricalPE, historicalPEPercentile } from '../valuationHistory.js';

const EXPERT_NAME = '估值建模专家';

const SYSTEM_PROMPT = `你是资深估值建模专家，精通 DCF 现金流折现、PE/PB/PS 相对估值、PEG 成长估值，拥有 15 年权益资产定价经验。
分析维度：
- 估值水平：当前 PE/PB 处于历史分位（极高/偏高/合理/偏低/极低）
- 同业对比：与同行业可比公司 PE/PB 对比，判断溢价或折价合理性
- PEG 合理性：结合利润增速评估 PE 与成长性匹配度（PEG<1 偏低，>1.5 偏高）
- DCF 内在价值：两阶段模型（高增长期 + Gordon 终端价值），WACC 用 CAPM 估算
- 股息率：估算分红回报与防御属性
要求：
- 多方法交叉验证，避免单一估值指标误导
- 明确给出估值结论：偏高 / 偏低 / 合理区间；数据不足时必须如实披露，不得强行结论
- 估算历史 PE 仅供展示，不得参与历史分位、评分或评级
- evidenceType 标注：fact=直接数据事实，inference=基于数据的推断，hypothesis=假设性判断，assumption=数据不足或依赖未验证假设
- overallSentiment 综合估值分位、PEG、DCF 安全边际客观判断`;

/** 规则引擎研判（LLM 不可用时降级使用）。 */
function valuationExpertRule(
  financial: FinancialData,
  valuation: ValuationData,
  info: StockInfo,
): ExpertOpinion {
  const n = financial.years.length;
  const idx = n - 1;
  const arguments_: ExpertOpinion['arguments'] = [];
  const currentPE = valuation.pe;
  const pePercentile = historicalPEPercentile(valuation);
  const estimatedHistory = hasEstimatedHistoricalPE(valuation);

  // 历史 PE：只有真实样本才产生方向性结论；估算序列必须披露且降低置信度。
  if (pePercentile === null) {
    arguments_.push({
      text: `历史PE数据不足，无法判断当前PE ${currentPE}x的历史分位与安全边际。${estimatedHistory ? '展示序列包含由当前PE反推的估算值，不参与分位与评级。' : ''}`,
      confidence: 20,
      type: 'oppose',
      evidenceType: 'assumption',
    });
  } else if (pePercentile < 30) {
    arguments_.push({
      text: `当前PE ${currentPE}x处于真实历史${pePercentile.toFixed(0)}%分位，相对历史估值偏低，但安全边际仍需结合盈利质量验证。`,
      confidence: 65,
      type: 'support',
      evidenceType: 'inference',
    });
  } else if (pePercentile > 70) {
    arguments_.push({
      text: `当前PE ${currentPE}x处于真实历史${pePercentile.toFixed(0)}%分位，相对历史估值偏高，存在估值回落风险。`,
      confidence: 65,
      type: 'oppose',
      evidenceType: 'inference',
    });
  } else {
    arguments_.push({
      text: `当前PE ${currentPE}x处于真实历史${pePercentile.toFixed(0)}%分位，未处于历史极端区间。`,
      confidence: 55,
      type: 'support',
      evidenceType: 'inference',
    });
  }

  // PEG 仅在 PE 与正利润增速均有效时有意义。
  const previousProfit = n >= 2 ? financial.netProfit[idx - 1] : 0;
  const latestProfitGrowth =
    n >= 2 && Number.isFinite(previousProfit) && previousProfit !== 0
      ? safeDiv(financial.netProfit[idx] - previousProfit, Math.abs(previousProfit)) * 100
      : null;
  const peg =
    latestProfitGrowth !== null && latestProfitGrowth > 0 && currentPE > 0
      ? safeDiv(currentPE, latestProfitGrowth)
      : null;
  if (peg === null || !Number.isFinite(peg)) {
    arguments_.push({
      text: 'PE或正利润增速数据不足，无法计算有经济含义的PEG，不作“低于1”或成长性价比判断。',
      confidence: 20,
      type: 'oppose',
      evidenceType: 'assumption',
    });
  } else {
    const pegDirection = peg < 1 ? '偏低' : peg > 1.5 ? '偏高' : '中间';
    arguments_.push({
      text: `按最近一年利润增速${latestProfitGrowth!.toFixed(1)}%计算，PEG约${peg.toFixed(2)}，处于${pegDirection}区间；该结果对单年增速敏感。`,
      confidence: 55,
      type: peg < 1 ? 'support' : 'oppose',
      evidenceType: 'inference',
    });
  }

  // DCF 两阶段模型；任何输入不足都显式降级，不输出 NaN 或伪精确价值。
  let dcfPerShare: number | null = null;
  if (n > 0 && valuation.marketCap > 0 && valuation.currentPrice > 0) {
    const latestFCF =
      financial.operatingCashFlow[idx] -
      Math.abs(financial.capEx?.[idx] ?? financial.totalAssets[idx] * 0.03);
    const riskFreeRate = 0.025;
    const marketRiskPremium = 0.06;
    const costOfEquity = riskFreeRate + marketRiskPremium;
    const wacc = costOfEquity * 0.75 + 0.045 * (1 - 0.25) * 0.25;
    const revenueGrowthLatest =
      n >= 2 && financial.revenue[idx - 1] !== 0
        ? safeDiv(
            financial.revenue[idx] - financial.revenue[idx - 1],
            Math.abs(financial.revenue[idx - 1]),
          )
        : 0;
    const growthRate = Math.min(Math.max(revenueGrowthLatest, 0), 0.25);
    let pvSum = 0;
    let fcf = latestFCF;
    for (let t = 1; t <= 5; t++) {
      fcf *= 1 + growthRate;
      pvSum += fcf / Math.pow(1 + wacc, t);
    }
    const terminalGrowthRate = Math.min(riskFreeRate, 0.03);
    const terminalValue = safeDiv(fcf * (1 + terminalGrowthRate), wacc - terminalGrowthRate);
    const enterpriseValue = pvSum + safeDiv(terminalValue, Math.pow(1 + wacc, 5));
    const totalSharesYi = safeDiv(valuation.marketCap, valuation.currentPrice);
    const estimate = safeDiv(enterpriseValue, totalSharesYi);
    if (Number.isFinite(estimate) && estimate > 0) dcfPerShare = estimate;
  }
  if (dcfPerShare === null) {
    arguments_.push({
      text: '现金流、资本开支或股本数据不足，DCF无法形成有效每股价值，不输出内在价值结论。',
      confidence: 20,
      type: 'oppose',
      evidenceType: 'assumption',
    });
  } else {
    const ratio = dcfPerShare / valuation.currentPrice;
    arguments_.push({
      text: `在默认WACC、增长率和资本开支假设下，DCF估算每股价值约${dcfPerShare.toFixed(2)}元，为当前价${valuation.currentPrice}元的${ratio.toFixed(2)}倍；结果属于模型假设而非事实。`,
      confidence: 45,
      type: ratio >= 1 ? 'support' : 'oppose',
      evidenceType: 'hypothesis',
    });
  }

  // 分红率固定为 30% 仅是情景假设，不能据此无条件宣称“具备吸引力”。
  const eps = n > 0 ? financial.eps[idx] : 0;
  if (eps > 0 && valuation.currentPrice > 0) {
    const dividendYield = safeDiv(eps * 0.3, valuation.currentPrice) * 100;
    arguments_.push({
      text: `若假设分红率为30%，估算股息率约${dividendYield.toFixed(1)}%；实际分红能力需以公司分红公告验证。`,
      confidence: 35,
      type: dividendYield >= 2 ? 'support' : 'oppose',
      evidenceType: 'assumption',
    });
  }

  // 同业比较由真实相对位置决定方向，不再无条件输出“PB高于同业”或“行业调整”。
  const validPeers = valuation.peerComparison.filter((peer) => peer.pe > 0 && peer.pb > 0);
  if (validPeers.length === 0) {
    arguments_.push({
      text: `缺少${info.industry}同业有效PE/PB数据，无法判断${info.name}相对同业的溢价或折价。`,
      confidence: 20,
      type: 'oppose',
      evidenceType: 'assumption',
    });
  } else {
    const peerAvgPE = validPeers.reduce((sum, peer) => sum + peer.pe, 0) / validPeers.length;
    const peerAvgPB = validPeers.reduce((sum, peer) => sum + peer.pb, 0) / validPeers.length;
    const pePremium = currentPE > peerAvgPE;
    const pbPremium = valuation.pb > peerAvgPB;
    arguments_.push({
      text: `同业有效样本平均PE ${peerAvgPE.toFixed(1)}x、PB ${peerAvgPB.toFixed(1)}x；当前PE/PB分别为${currentPE}x/${valuation.pb}x，相对同业呈${pePremium ? 'PE溢价' : 'PE折价'}、${pbPremium ? 'PB溢价' : 'PB折价'}。`,
      confidence: 60,
      type: pePremium || pbPremium ? 'oppose' : 'support',
      evidenceType: 'inference',
    });
  }

  // 利润增速只在可比较时描述真实变化，不强行制造“放缓趋势”。
  if (n >= 3 && latestProfitGrowth !== null && financial.netProfit[idx - 2] !== 0) {
    const prevYearGrowth =
      safeDiv(
        financial.netProfit[idx - 1] - financial.netProfit[idx - 2],
        Math.abs(financial.netProfit[idx - 2]),
      ) * 100;
    if (Number.isFinite(prevYearGrowth)) {
      const slowed = latestProfitGrowth < prevYearGrowth;
      arguments_.push({
        text: `利润增速由${financial.years[idx - 2]}年的${prevYearGrowth.toFixed(1)}%变为${financial.years[idx]}年的${latestProfitGrowth.toFixed(1)}%，同比口径显示增速${slowed ? '放缓' : '加快'}。`,
        confidence: 70,
        type: slowed ? 'oppose' : 'support',
        evidenceType: 'fact',
      });
    }
  }

  const overallSentiment =
    pePercentile === null
      ? 'neutral'
      : pePercentile < 30
        ? 'bullish'
        : pePercentile > 70
          ? 'bearish'
          : 'neutral';
  const avgConfidence = Math.round(
    arguments_.reduce((sum, argument) => sum + argument.confidence, 0) / arguments_.length,
  );

  return {
    expert: EXPERT_NAME,
    arguments: arguments_,
    overallSentiment,
    // 无真实历史序列时压低整位估值专家的可信度，避免其它模型假设补足虚假确定性。
    confidence: pePercentile === null ? Math.min(avgConfidence, 40) : avgConfidence,
    keyPoints: arguments_.slice(0, 6).map((argument) => argument.text),
  };
}

/** 估值建模专家：LLM 可用时调用 LLM，不可用或失败时降级规则引擎。 */
export async function valuationExpert(
  financial: FinancialData,
  valuation: ValuationData,
  info: StockInfo,
  extraBrief?: string | null,
): Promise<ExpertOpinion> {
  return runExpertWithLLM({
    expertName: EXPERT_NAME,
    systemPrompt: SYSTEM_PROMPT,
    context: formatContext(financial, valuation, info, extraBrief),
    ruleFallback: () => valuationExpertRule(financial, valuation, info),
  });
}
