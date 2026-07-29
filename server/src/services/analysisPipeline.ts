import type { AnalysisResult, ExpertOpinion, ScoreDetail, FinancialData, ValuationData, DataSource } from '../types.js';
import { getData } from './dataService.js';
import { fundamentalExpert } from './experts/fundamentalExpert.js';
import { valuationExpert } from './experts/valuationExpert.js';
import { industryExpert, type IndustryExpertResult } from './experts/industryExpert.js';
import { riskExpert } from './experts/riskExpert.js';
import { arbitrationExpert } from './experts/arbitrationExpert.js';

export async function runAnalysis(stockCode: string): Promise<AnalysisResult> {
  // 1. 数据获取
  const { info, financial, valuation } = await getData(stockCode);
  const n = financial.years.length;

  // 2. 多专家独立研判（并行调用）
  const [fundOpinion, valOpinion, indOpinionResult, riskOpinion] = await Promise.all([
    Promise.resolve(fundamentalExpert(financial, valuation, info)),
    Promise.resolve(valuationExpert(financial, valuation, info)),
    Promise.resolve(industryExpert(financial, valuation, info)),
    Promise.resolve(riskExpert(financial, valuation, info))
  ]);

  // 提取行业专家结果和景气度建议
  const indOpinion: IndustryExpertResult = indOpinionResult;
  const expertOpinions: ExpertOpinion[] = [fundOpinion, valOpinion, indOpinion, riskOpinion];

  // 3. 辩论仲裁
  const { controversies, finalOpinion } = arbitrationExpert({
    financial,
    valuation,
    info,
    opinions: expertOpinions
  });

  const allOpinions = [...expertOpinions, finalOpinion];

  // === 提前计算公共指标（后续多处引用） ===
  const revenueGrowthLatest = financial.revenue[n - 2] !== 0
    ? (financial.revenue[n - 1] - financial.revenue[n - 2]) / Math.abs(financial.revenue[n - 2]) * 100 : 0;
  const profitGrowthLatest = financial.netProfit[n - 2] !== 0
    ? (financial.netProfit[n - 1] - financial.netProfit[n - 2]) / Math.abs(financial.netProfit[n - 2]) * 100 : 0;
  const cashFlowRatio = financial.netProfit[n - 1] !== 0
    ? financial.operatingCashFlow[n - 1] / financial.netProfit[n - 1] : 0;
  const grossMarginRange = Math.max(...financial.grossMargin) - Math.min(...financial.grossMargin);

  // PE 历史分位
  const peValues = valuation.historicalPE.map(h => h.pe).sort((a, b) => a - b);
  const pePercentile = (peValues.filter(p => p <= valuation.pe).length / peValues.length) * 100;

  // 4. 双层自省
  const reflectionNotes: string[] = [];

  // 第一层：事实自省 - 基于数据阈值触发
  // 营收增速与专家情绪矛盾检查
  if (revenueGrowthLatest < 5 && fundOpinion.overallSentiment === 'bullish') {
    reflectionNotes.push(`【自省】营收增速仅${revenueGrowthLatest.toFixed(1)}%，基本面专家仍看多，可能存在乐观偏差。`);
  }

  // 现金流/利润一致性检查
  if (cashFlowRatio < 0.5) {
    reflectionNotes.push(`【自省·警告】经营现金流/净利润仅${cashFlowRatio.toFixed(2)}，盈利质量存疑。`);
  } else if (cashFlowRatio > 0.9) {
    reflectionNotes.push(`【自省·验证通过】经营现金流/净利润=${cashFlowRatio.toFixed(2)}，盈利质量可靠。`);
  }

  // 毛利率稳定性检查
  if (grossMarginRange > 10) {
    reflectionNotes.push(`【自省·警告】毛利率波动${grossMarginRange.toFixed(1)}个百分点，盈利稳定性较差。`);
  } else if (grossMarginRange < 3) {
    reflectionNotes.push(`【自省·验证通过】毛利率波动仅${grossMarginRange.toFixed(1)}个百分点，稳定性高。`);
  }

  // 第二层：逻辑闭环 - 通用化 4 个自问
  // 逻辑闭环①：历史数据外推的局限性
  reflectionNotes.push(
    `【逻辑闭环①】分析基于${n}年财务数据外推，历史趋势在行业拐点可能失效。数据跨度${n}年（${financial.years[0]}-${financial.years[n - 1]}）。`
  );

  // 逻辑闭环②：最可能的看错场景（从动态风险列表取第一条）
  // 注意：actualRisks 在后面计算，这里先预计算
  const preComputedRisks = allOpinions.flatMap(o =>
    o.arguments
      .filter(a => a.type === 'oppose' && a.confidence >= 65)
      .map(a => a.text.length > 60 ? a.text.slice(0, 57) + '...' : a.text)
  ).slice(0, 6);
  const topRisk = preComputedRisks[0] || '未知风险';
  reflectionNotes.push(`【逻辑闭环②】最可能的"看错"场景：${topRisk}。`);

  // 逻辑闭环③：市场是否已 price in（基于 PE 历史分位）
  if (pePercentile <= 20) {
    reflectionNotes.push(`【逻辑闭环③】当前PE处于历史${pePercentile.toFixed(0)}%分位，市场可能已充分反映悲观预期。`);
  } else if (pePercentile >= 80) {
    reflectionNotes.push(`【逻辑闭环③】当前PE处于历史${pePercentile.toFixed(0)}%分位，乐观预期可能已充分定价。`);
  } else {
    reflectionNotes.push(`【逻辑闭环③】当前PE处于历史${pePercentile.toFixed(0)}%分位，估值处于合理区间。`);
  }

  // 逻辑闭环④：关键跟踪指标（基于专家情绪动态判断）
  const topConcern = indOpinion.overallSentiment === 'bearish' ? '行业景气度下行' :
    valOpinion.overallSentiment === 'bearish' ? '估值压力' : '基本面变化';
  reflectionNotes.push(`【逻辑闭环④】如果只能跟踪一个方向，应重点关注：${topConcern}。`);

  // 5. 量化打分（传入行业景气度建议）
  const industrySuggestion = (indOpinion as IndustryExpertResult).industryScoreSuggestion;
  const scoreDetail = calculateScores(financial, valuation, industrySuggestion);
  const totalScore = scoreDetail.profit_quality + scoreDetail.growth + scoreDetail.valuation +
    scoreDetail.industry_boom + scoreDetail.risk_deduction;

  // 6. 综合评级
  let rating: string;
  if (totalScore >= 80) rating = '优先跟踪';
  else if (totalScore >= 60) rating = '持续观察';
  else if (totalScore >= 40) rating = '谨慎观望';
  else rating = '建议规避';

  // 7. 估值水平判断
  let valuationLevel: string;
  if (pePercentile <= 20) valuationLevel = '历史低估';
  else if (pePercentile <= 40) valuationLevel = '偏低估';
  else if (pePercentile <= 60) valuationLevel = '合理';
  else if (pePercentile <= 80) valuationLevel = '偏高估';
  else valuationLevel = '历史高估';

  // 8. 生成核心摘要（动态，无硬编码文本）
  const sentimentWord = fundOpinion.overallSentiment === 'bullish' ? '优秀' :
    fundOpinion.overallSentiment === 'bearish' ? '偏弱' : '中等';
  const coreSummary = `${info.name}（${info.code}）属于${info.industry}行业，当前PE ${valuation.pe}x（${valuationLevel}）。` +
    `盈利质量${sentimentWord}（毛利率${financial.grossMargin[n - 1]}%、ROE ${financial.roe[n - 1]}%），` +
    `最新营收增速${revenueGrowthLatest.toFixed(1)}%、利润增速${profitGrowthLatest.toFixed(1)}%。` +
    `综合评分${totalScore}/100，评级：${rating}。`;

  // 9. 优势与风险列表（从专家论点动态提取）
  const actualStrengths = allOpinions.flatMap(o =>
    o.arguments
      .filter(a => a.type === 'support' && a.confidence >= 70)
      .map(a => a.text.length > 60 ? a.text.slice(0, 57) + '...' : a.text)
  ).slice(0, 6);

  const actualRisks = preComputedRisks;

  // 10. 后续跟踪指标（动态生成）
  const followUpIndicators: string[] = [];
  // 通用指标
  followUpIndicators.push('季度营收/净利润增速变化');
  followUpIndicators.push('经营现金流/净利润比率');
  followUpIndicators.push('毛利率/净利率趋势变化');

  // 基于风险专家发现的财务风险动态添加
  if (financial.revenue[n - 1] !== 0 && financial.accountsReceivable[n - 1] / financial.revenue[n - 1] * 100 > 10) {
    followUpIndicators.push('应收账款周转天数变化（占营收比例偏高）');
  }
  if (financial.goodwill[n - 1] > 0) {
    followUpIndicators.push('商誉减值风险跟踪');
  }
  if (financial.debtRatio[n - 1] > 50) {
    followUpIndicators.push('资产负债率变化（杠杆偏高）');
  }

  // 基于行业特征
  followUpIndicators.push(`${info.industry}行业政策动向`);
  followUpIndicators.push('同业可比公司估值变化');

  // 基于估值分位
  if (pePercentile <= 30) {
    followUpIndicators.push('PE 是否继续下探（当前处于历史低位区间）');
  } else if (pePercentile >= 70) {
    followUpIndicators.push('PE 是否见顶回落（当前处于历史高位区间）');
  }

  // 11. 数据来源（动态，基于实际数据年份）
  const dataSources: DataSource[] = [
    { name: '年度财务报告', description: `公司${financial.years[0]}-${financial.years[n - 1]}年公开年报数据`, confidence: 90 },
    { name: '实时行情数据', description: '东方财富/新浪财经实时行情接口', confidence: 85 },
    { name: '行业对比数据', description: '同业可比公司公开财务指标', confidence: 80 },
    { name: '估值历史数据', description: '历史PE/PB等估值指标', confidence: 75 }
  ];

  return {
    stock_pool: [{
      stock_code: info.code,
      stock_name: info.name,
      industry: info.industry,
      core_summary: coreSummary,
      total_score: totalScore,
      rating,
      score_detail: scoreDetail,
      strengths: actualStrengths,
      risk_list: actualRisks,
      controversy_points: controversies,
      finance_metrics: financial,
      valuation,
      valuation_level: valuationLevel,
      expert_opinions: allOpinions,
      reflection_notes: reflectionNotes,
      chart_list: [],
      follow_up_indicators: followUpIndicators
    }],
    data_sources: dataSources,
    research_confidence: `基于${allOpinions.length}位专家独立研判+仲裁综合，整体置信度${Math.round(allOpinions.reduce((s, o) => s + o.confidence, 0) / allOpinions.length)}%。财务数据置信度高（上市公司年报审计），行业判断置信度中等（存在政策不确定性）。`,
    limitation_explain: '本分析基于公开财务数据和行业信息，未包含非公开信息、实地调研、管理层访谈等。数据截止至最近年报，可能存在滞后性。分析模型为定性+定量结合，不构成投资建议。'
  };
}

function calculateScores(financial: FinancialData, valuation: ValuationData, industryScoreSuggestion?: number): ScoreDetail {
  const n = financial.years.length;

  // === 盈利质量 (0-20) ===
  const avgGrossMargin = financial.grossMargin.reduce((a, b) => a + b, 0) / n;
  const grossMarginStability = Math.max(...financial.grossMargin) - Math.min(...financial.grossMargin);
  const avgROE = financial.roe.reduce((a, b) => a + b, 0) / n;
  const avgCashFlowRatio = financial.operatingCashFlow.reduce((s, cf, i) => {
    return s + (financial.netProfit[i] !== 0 ? cf / financial.netProfit[i] : 0);
  }, 0) / n;

  let profitScore = 0;
  // 毛利率水平 (0-5)
  profitScore += Math.min(5, (avgGrossMargin / 100) * 6);
  // 毛利率稳定性 (0-3)
  profitScore += Math.max(0, 3 - grossMarginStability * 1.5);
  // ROE (0-5)
  profitScore += Math.min(5, (avgROE / 35) * 5);
  // 现金流质量 (0-4)
  profitScore += Math.min(4, avgCashFlowRatio * 3.2);
  // 应收质量 (0-2)：应收账款/营收占比越低越好
  const arRatioProfit = financial.revenue[n - 1] !== 0
    ? financial.accountsReceivable[n - 1] / Math.abs(financial.revenue[n - 1]) * 100 : 0;
  profitScore += Math.max(0, 2 - arRatioProfit * 0.3);
  profitScore = Math.min(20, Math.round(profitScore));

  // === 成长性 (0-20) ===
  const revenueCAGR = safeCAGR(financial.revenue[0], financial.revenue[n - 1], n - 1);
  const profitCAGR = safeCAGR(financial.netProfit[0], financial.netProfit[n - 1], n - 1);
  const latestProfitGrowth = financial.netProfit[n - 2] !== 0
    ? (financial.netProfit[n - 1] - financial.netProfit[n - 2]) / Math.abs(financial.netProfit[n - 2]) * 100
    : 0;

  let growthScore = 0;
  // 营收CAGR (0-7)
  growthScore += Math.min(7, (revenueCAGR / 15) * 7);
  // 利润CAGR (0-7)
  growthScore += Math.min(7, (profitCAGR / 18) * 7);
  // 最新增速 (0-6) - 负增长不给分
  if (latestProfitGrowth > 0) {
    growthScore += Math.min(6, (latestProfitGrowth / 20) * 6);
  }
  // 增长稳定性调整：用营收增长的标准差作为惩罚因子
  const revenueGrowthRatesForStability: number[] = [];
  for (let i = 1; i < financial.revenue.length; i++) {
    const prev = Math.abs(financial.revenue[i - 1]);
    if (prev > 0) {
      revenueGrowthRatesForStability.push(
        (financial.revenue[i] - financial.revenue[i - 1]) / prev * 100
      );
    }
  }
  if (revenueGrowthRatesForStability.length > 0) {
    const growthMean = revenueGrowthRatesForStability.reduce((a, b) => a + b, 0) / revenueGrowthRatesForStability.length;
    const growthStd = Math.sqrt(
      revenueGrowthRatesForStability.reduce((s, g) => s + (g - growthMean) ** 2, 0) / revenueGrowthRatesForStability.length
    );
    const stabilityFactor = Math.max(0.5, 1 - growthStd / 50); // 标准差越大，惩罚越重（最低打5折）
    growthScore *= stabilityFactor;
  }
  growthScore = Math.min(20, Math.round(growthScore));

  // === 估值性价比 (0-20) ===
  const peValues = valuation.historicalPE.map(h => h.pe).sort((a, b) => a - b);
  const pePercentile = (peValues.filter(p => p <= valuation.pe).length / peValues.length) * 100;

  let valScore = 0;
  // 历史分位 (0-6)
  valScore += Math.max(0, 6 - (pePercentile / 100) * 6);

  // 同业对比 (0-6) — 空数组保护
  let peerValScore = 3; // 默认中性分
  if (valuation.peerComparison.length > 0) {
    const peerAvgPE = valuation.peerComparison.reduce((s, p) => s + p.pe, 0) / valuation.peerComparison.length;
    peerValScore = isFinite(peerAvgPE / valuation.pe)
      ? Math.min(6, Math.max(0, (peerAvgPE / valuation.pe) * 3))
      : 3;
  }
  valScore += peerValScore;

  // PEG (0-4) — 负增长时改用 PB-ROE 模型
  if (latestProfitGrowth > 0) {
    const peg = valuation.pe / latestProfitGrowth;
    valScore += isFinite(peg) ? Math.min(4, Math.max(0, (1.5 - peg) * 4)) : 0;
  } else {
    // 负增长：用 PB/ROE 替代 PEG，比值越低越好
    const avgROEForPeg = financial.roe.reduce((a, b) => a + b, 0) / n;
    if (avgROEForPeg > 0) {
      const pbRoeRatio = valuation.pb / (avgROEForPeg / 100);
      valScore += isFinite(pbRoeRatio) ? Math.min(4, Math.max(0, (3 - pbRoeRatio) * 1.5)) : 0;
    } else {
      valScore += 0; // ROE 也为负，不给分
    }
  }

  // 估值动量 (0-2)：当前PE vs 历史PE中位数的变化方向
  const peSorted = valuation.historicalPE.map(h => h.pe).sort((a, b) => a - b);
  const peMedian = peSorted.length > 0 ? peSorted[Math.floor(peSorted.length / 2)] : valuation.pe;
  if (isFinite(peMedian) && peMedian > 0) {
    const peMomentum = (peMedian - valuation.pe) / peMedian; // 正值=当前PE低于中位数=低估
    if (peMomentum > 0.1) {
      valScore += 2; // 明显低估
    } else if (peMomentum > 0) {
      valScore += 1; // 轻微低估
    }
    // 负值不加分（高估不给额外扣分，因为PE分位已经处理了）
  }
  valScore = Math.min(20, Math.round(valScore));

  // === 行业景气度 (0-20) ===
  // 优先使用行业专家的量化建议，否则降级计算
  let industryScore: number;
  if (typeof industryScoreSuggestion === 'number') {
    industryScore = industryScoreSuggestion;
  } else {
    // 降级计算：基于营收增速趋势 + 毛利率趋势
    const revenueGrowthRates: number[] = [];
    for (let i = 1; i < n; i++) {
      revenueGrowthRates.push((financial.revenue[i] - financial.revenue[i - 1]) / financial.revenue[i - 1] * 100);
    }
    const avgRevenueGrowth = revenueGrowthRates.reduce((a, b) => a + b, 0) / revenueGrowthRates.length;
    const grossMarginTrend = financial.grossMargin[n - 1] - financial.grossMargin[0];

    let baseScore = 10; // 基础分
    if (avgRevenueGrowth > 15) baseScore += 5;
    else if (avgRevenueGrowth > 10) baseScore += 4;
    else if (avgRevenueGrowth > 5) baseScore += 3;
    else if (avgRevenueGrowth > 0) baseScore += 1;
    else baseScore -= 3;

    if (grossMarginTrend > 3) baseScore += 2;
    else if (grossMarginTrend < -3) baseScore -= 2;

    industryScore = Math.min(20, Math.max(0, Math.round(baseScore)));
  }

  // === 风险水平 (0-20) ===
  // 风险越低分越高
  let riskScore = 0;
  // 财务风险 (0-7)：资产负债率越低越好
  riskScore += Math.max(0, 7 - (financial.debtRatio[n - 1] / 100) * 15);
  // 商誉风险 (0-5)：商誉/净资产越低越好
  const goodwillRatio = financial.equity[n - 1] !== 0
    ? financial.goodwill[n - 1] / Math.abs(financial.equity[n - 1]) * 100 : 0;
  riskScore += Math.max(0, 5 - goodwillRatio * 0.5);
  // 应收风险 (0-4)
  const arRatio = financial.revenue[n - 1] !== 0
    ? financial.accountsReceivable[n - 1] / Math.abs(financial.revenue[n - 1]) * 100 : 0;
  riskScore += Math.max(0, 4 - arRatio * 10);
  // 政策/行业风险 (0-4)：基于财务数据波动性动态计算
  const revenueVolatility = calculateVolatility(financial.revenue);
  const profitVolatility = calculateVolatility(financial.netProfit);
  const avgVolatility = (revenueVolatility + profitVolatility) / 2;
  // 波动越大，风险越高（分越低）
  const policyRisk = isFinite(avgVolatility) ? Math.min(4, Math.max(0, 4 - avgVolatility * 10)) : 2;
  riskScore += policyRisk;

  // 财务异常信号 (0-3)：检测常见预警
  let anomalyScore = 3; // 满分=无异常

  // 应收暴增检测：最新应收增速 vs 营收增速
  if (n >= 2 && financial.accountsReceivable[n - 2] !== 0 &&
      isFinite(financial.accountsReceivable[n - 1] / financial.accountsReceivable[n - 2])) {
    const arGrowth = (financial.accountsReceivable[n - 1] - financial.accountsReceivable[n - 2]) /
      Math.abs(financial.accountsReceivable[n - 2]) * 100;
    const revGrowth = financial.revenue[n - 2] !== 0
      ? (financial.revenue[n - 1] - financial.revenue[n - 2]) / Math.abs(financial.revenue[n - 2]) * 100 : 0;
    if (arGrowth > revGrowth * 1.5 && arGrowth > 20) {
      anomalyScore -= 1.5; // 应收暴增预警
    }
  }

  // 现金流长期背离净利润
  const cashFlowDivorce = financial.operatingCashFlow.filter((cf, i) =>
    financial.netProfit[i] !== 0 && isFinite(cf / financial.netProfit[i]) && cf < financial.netProfit[i] * 0.7
  ).length;
  if (cashFlowDivorce >= 3) {
    anomalyScore -= 1.5; // 连续3年以上现金流低于净利润70%
  }

  riskScore += Math.max(0, anomalyScore);
  riskScore = Math.min(20, Math.round(riskScore));

  return {
    profit_quality: profitScore,
    growth: growthScore,
    valuation: valScore,
    industry_boom: industryScore,
    risk_deduction: riskScore
  };
}

/** 计算数组的波动系数（标准差） */
function calculateVolatility(values: number[]): number {
  if (values.length < 2) return 0;
  const returns: number[] = [];
  for (let i = 1; i < values.length; i++) {
    if (values[i - 1] !== 0) {
      returns.push((values[i] - values[i - 1]) / Math.abs(values[i - 1]));
    }
  }
  if (returns.length === 0) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance);
}

/** 安全 CAGR 计算：起始值<=0时返回0避免NaN */
function safeCAGR(startVal: number, endVal: number, years: number): number {
  if (years <= 0) return 0;
  if (startVal <= 0 || endVal <= 0) return 0;
  const result = (Math.pow(endVal / startVal, 1 / years) - 1) * 100;
  return isFinite(result) ? result : 0;
}
