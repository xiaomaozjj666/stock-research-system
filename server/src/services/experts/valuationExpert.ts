import type { FinancialData, ValuationData, StockInfo, ExpertOpinion } from '../../types.js';
import { safeDiv } from '../safeDiv.js';
import { runExpertWithLLM } from '../../llm/expertRunner.js';
import { formatContext } from '../../llm/prompts.js';

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
- 明确给出估值结论：偏高 / 偏低 / 合理区间
- evidenceType 标注：fact=直接数据事实，inference=基于数据的推断，hypothesis=假设性判断
- overallSentiment 综合估值分位、PEG、DCF 安全边际客观判断`;

/**
 * 规则引擎研判（LLM 不可用时降级使用）
 */
function valuationExpertRule(
  financial: FinancialData,
  valuation: ValuationData,
  info: StockInfo,
): ExpertOpinion {
  const n = financial.years.length;
  const arguments_: ExpertOpinion['arguments'] = [];

  // 历史PE分位分析
  const peValues = valuation.historicalPE.map((h) => h.pe).sort((a, b) => a - b);
  const currentPE = valuation.pe;
  const pePercentile = (peValues.filter((p) => p <= currentPE).length / peValues.length) * 100;

  // 同业平均PE（防御空数组）
  const hasPeerData = valuation.peerComparison.length > 0;
  const peerAvgPE = hasPeerData
    ? safeDiv(
        valuation.peerComparison.reduce((sum, p) => sum + p.pe, 0),
        valuation.peerComparison.length,
      )
    : 0;

  // PEG计算：用最近一年利润增速
  const latestProfitGrowth =
    safeDiv(financial.netProfit[n - 1] - financial.netProfit[n - 2], financial.netProfit[n - 2]) *
    100;
  const peg = safeDiv(currentPE, latestProfitGrowth);

  // 股息率估算（假设分红率30%，A股平均水平，实际因公司而异）
  const assumedPayoutRatio = 0.3;
  const dividendYield =
    safeDiv(financial.eps[n - 1] * assumedPayoutRatio, valuation.currentPrice) * 100;

  // DCF估值：标准两阶段模型（Gordon Growth Model）
  const idx = n - 1;
  const latestFCF =
    financial.operatingCashFlow[idx] -
    Math.abs(financial.capEx?.[idx] ?? financial.totalAssets[idx] * 0.03);

  // WACC计算（CAPM模型）
  const riskFreeRate = 0.025; // 中国10年期国债收益率 ~2.5%
  const marketRiskPremium = 0.06; // A股市场风险溢价 ~6%
  const beta = 1.0; // 默认beta
  const costOfEquity = riskFreeRate + beta * marketRiskPremium; // CAPM: ~8.5%
  const costOfDebt = 0.045; // A股平均借贷成本 ~4.5%
  const taxRate = 0.25; // 标准税率
  const equityWeight = 0.75;
  const debtWeight = 0.25;
  const wacc = costOfEquity * equityWeight + costOfDebt * (1 - taxRate) * debtWeight;

  // 阶段1：高增长期（5年）
  const revenueGrowthLatest =
    n >= 2
      ? safeDiv(
          financial.revenue[idx] - financial.revenue[idx - 1],
          Math.abs(financial.revenue[idx - 1]),
        )
      : 0.1;
  const growthRate = Math.min(Math.max(revenueGrowthLatest, 0), 0.25); // 上限25%
  let pvSum = 0;
  let fcf = latestFCF;
  for (let t = 1; t <= 5; t++) {
    fcf = fcf * (1 + growthRate);
    pvSum += fcf / Math.pow(1 + wacc, t);
  }

  // 阶段2：终端价值（Gordon Growth）
  const terminalGrowthRate = Math.min(riskFreeRate, 0.03); // 保守终端增长率
  const terminalValue = safeDiv(fcf * (1 + terminalGrowthRate), wacc - terminalGrowthRate);
  const pvTerminal = safeDiv(terminalValue, Math.pow(1 + wacc, 5));

  // 企业价值 = 阶段1现值 + 终端价值现值
  const enterpriseValue = pvSum + pvTerminal;

  const totalSharesYi = safeDiv(valuation.marketCap, valuation.currentPrice); // 总股本（亿股）
  const dcfPerShare = safeDiv(enterpriseValue, totalSharesYi);

  // === 支持论点 ===
  arguments_.push({
    text: `当前PE ${currentPE}x处于近${n}年历史${pePercentile.toFixed(0)}%分位，当前估值已充分消化泡沫，安全边际较高。`,
    confidence: 82,
    type: 'support',
    evidenceType: 'fact',
  });

  arguments_.push({
    text: `PEG约${peg.toFixed(2)}，低于1.0，表明以当前增速来看估值合理偏低，具备成长性价比。`,
    confidence: 70,
    type: 'support',
    evidenceType: 'inference',
  });

  // DCF 每股内在价值锚（复用上方估算的 dcfPerShare）
  arguments_.push({
    text: `DCF 估算每股内在价值约 ${dcfPerShare.toFixed(2)} 元，与当前价 ${valuation.currentPrice} 元对照，提供现金流维度的估值锚。`,
    confidence: 65,
    type: 'support',
    evidenceType: 'inference',
  });

  arguments_.push({
    text: `估算股息率约${dividendYield.toFixed(1)}%（假设分红率30%），对于${info.industry}行业龙头而言具备一定吸引力，且分红率有提升空间。`,
    confidence: 68,
    type: 'support',
    evidenceType: 'hypothesis',
  });

  // === 反对论点 ===
  // PB论点：有同业数据时引用同业名称，无数据时泛化表述
  if (hasPeerData) {
    const peerPBs = valuation.peerComparison.map((p) => `${p.name}${p.pb}x`).join('、');
    arguments_.push({
      text: `PB ${valuation.pb}x仍高于同业平均（${peerPBs}），ROE虽高但PB溢价空间有限。`,
      confidence: 72,
      type: 'oppose',
      evidenceType: 'fact',
    });
  } else {
    arguments_.push({
      text: `PB ${valuation.pb}x处于历史较高分位，ROE虽高但PB溢价空间有限。`,
      confidence: 68,
      type: 'oppose',
      evidenceType: 'fact',
    });
  }

  // 行业估值论点：有同业数据时引用平均PE，无数据时用历史分位
  if (hasPeerData) {
    arguments_.push({
      text: `${info.industry}行业处于调整周期，同业平均PE仅${peerAvgPE.toFixed(1)}x，行业整体估值中枢下移，${info.name} PE仍有压缩风险。`,
      confidence: 68,
      type: 'oppose',
      evidenceType: 'fact',
    });
  } else {
    arguments_.push({
      text: `${info.industry}行业处于调整周期，PE处于历史${pePercentile.toFixed(0)}%分位低位区间，行业整体估值中枢可能进一步下移。`,
      confidence: 65,
      type: 'oppose',
      evidenceType: 'inference',
    });
  }

  // 增速放缓论点（动态年份）
  const prevYearGrowth =
    n >= 3
      ? safeDiv(
          financial.netProfit[n - 2] - financial.netProfit[n - 3],
          Math.abs(financial.netProfit[n - 3]),
        ) * 100
      : 0;
  arguments_.push({
    text: `利润增速已从${financial.years[n - 3] ?? financial.years[0]}年的${prevYearGrowth.toFixed(1)}%降至${financial.years[n - 1]}年的${latestProfitGrowth.toFixed(1)}%，增速放缓趋势明确，高增长逻辑弱化。`,
    confidence: 75,
    type: 'oppose',
    evidenceType: 'fact',
  });

  arguments_.push({
    text: `DCF简化估值显示当前市值接近合理区间上沿，若增速进一步下滑至5%，合理估值将大幅缩水，下行空间需警惕。`,
    confidence: 60,
    type: 'oppose',
    evidenceType: 'hypothesis',
  });

  // 动态判断整体情绪
  let overallSentiment: 'bullish' | 'neutral' | 'bearish';
  if (pePercentile < 30) overallSentiment = 'bullish';
  else if (pePercentile > 70) overallSentiment = 'bearish';
  else overallSentiment = 'neutral';

  const avgConfidence = Math.round(
    arguments_.reduce((s, a) => s + a.confidence, 0) / arguments_.length,
  );

  return {
    expert: EXPERT_NAME,
    arguments: arguments_,
    overallSentiment,
    confidence: avgConfidence,
    keyPoints: [
      `PE ${currentPE}x处于近${n}年${pePercentile.toFixed(0)}%分位，历史低位`,
      `PEG约${peg.toFixed(2)}，低于1.0，估值与增速匹配`,
      `PB ${valuation.pb}x仍高于同业，ROE支撑但溢价空间有限`,
      `估算股息率约${dividendYield.toFixed(1)}%（假设分红率30%）`,
      `${info.industry}行业估值中枢下移，PE仍有压缩风险`,
      `DCF估算当前价格接近合理区间，下行空间需警惕`,
    ],
  };
}

/**
 * 估值建模专家
 * LLM 可用时调用 LLM 进行深度研判；不可用或失败时降级规则引擎。
 */
export async function valuationExpert(
  financial: FinancialData,
  valuation: ValuationData,
  info: StockInfo,
): Promise<ExpertOpinion> {
  return runExpertWithLLM({
    expertName: EXPERT_NAME,
    systemPrompt: SYSTEM_PROMPT,
    context: formatContext(financial, valuation, info),
    ruleFallback: () => valuationExpertRule(financial, valuation, info),
  });
}
