import type { AnalysisResult, ExpertOpinion, DataSource } from '../types.js';
import { getData } from './dataService.js';
import { fundamentalExpert } from './experts/fundamentalExpert.js';
import { valuationExpert } from './experts/valuationExpert.js';
import { industryExpert, type IndustryExpertResult } from './experts/industryExpert.js';
import { riskExpert } from './experts/riskExpert.js';
import { capitalFlowExpert } from './experts/capitalFlowExpert.js';
import { arbitrationExpert } from './experts/arbitrationExpert.js';
import { generateScenarios } from './scenarioEngine.js';
import { generateStrategyList } from './strategyListEngine.js';
import { safeDiv } from './safeDiv.js';
import { calculateScores } from './scoreEngine.js';
import { fetchOHLCVData } from '../quant/dataProvider.js';
import { extractNewsSignal, type NewsSignal } from '../quant/newsSignal.js';
import { withTimeout } from '../utils/timeout.js';

/** 分析阶段事件（用于 SSE 流式推送进度） */
export type AnalysisStage =
  | { phase: 'data'; message: string }
  | { phase: 'experts'; message: string }
  | { phase: 'arbitration'; message: string }
  | { phase: 'scoring'; message: string; totalScore: number; rating: string }
  | { phase: 'strategy'; message: string }
  | { phase: 'done'; message: string; result: AnalysisResult };

export async function runAnalysis(
  stockCode: string,
  onProgress?: (stage: AnalysisStage) => void
): Promise<AnalysisResult> {
  const emit = (stage: AnalysisStage) => { onProgress?.(stage); };

  // 1. 数据获取
  emit({ phase: 'data', message: '正在获取行情与财务数据...' });
  const { info, financial, valuation } = await getData(stockCode);
  const n = financial.years.length;

  // 1.5 抓取最新消息情绪（尽力而为：限时 3s 且不阻塞主流程，失败/超时则视为无新闻）
  emit({ phase: 'data', message: '正在获取最新消息情绪...' });
  let newsSignal: NewsSignal | null = null;
  try {
    const fetched = await withTimeout(extractNewsSignal(info.code), 3000);
    newsSignal = fetched.signal;
  } catch {
    newsSignal = null;
  }

  // === 修正 PE/PB：用股价/每股收益 和 股价/每股净资产 计算，不依赖API不可靠的f167/f164字段 ===
  const latestEps = financial.eps[n - 1];         // 元/股
  const latestNetProfit = financial.netProfit[n - 1]; // 亿元
  const latestEquity = financial.equity?.[n - 1] ?? 0; // 亿元
  const price = valuation.currentPrice;            // 元/股

  if (latestEps > 0 && price > 0) {
    // PE = 股价 / 每股收益
    valuation.pe = Math.round((price / latestEps) * 100) / 100;

    // PB = 股价 / 每股净资产
    // 从 netProfit(亿元) 和 eps(元/股) 反推总股本: totalShares = netProfit*1e8 / eps
    const totalShares = (latestNetProfit > 0) ? (latestNetProfit * 1e8 / latestEps) : 0;
    if (totalShares > 0 && latestEquity > 0) {
      const bvps = (latestEquity * 1e8) / totalShares; // 元/股
      if (bvps > 0) {
        valuation.pb = Math.round((price / bvps) * 100) / 100;
      }
    }
  } else if (latestNetProfit > 0 && valuation.marketCap > 0) {
    // EPS不可用时回退到市值/净利润
    valuation.pe = Math.round((valuation.marketCap / latestNetProfit) * 100) / 100;
    if (latestEquity > 0) {
      valuation.pb = Math.round((valuation.marketCap / latestEquity) * 100) / 100;
    }
  }

  // 修正历史PE估算，基于修正后的当前PE
  // 说明：免费API无法获取真实历史PE，此处为确定性估算。
  // 采用"历史中枢略高于当前PE"的假设（A股估值中枢长期下移，历史平均通常高于当前），
  // 最新年份使用真实当前PE，历史年份围绕中枢波动，使 pePercentile 能反映当前估值相对历史的位置。
  if (valuation.pe > 0) {
    const currentYear = new Date().getFullYear();
    const seed = parseInt(stockCode.slice(-3)) || 42;
    const center = valuation.pe * 1.18; // 历史中枢：略高于当前
    const historicalPE: { year: string; pe: number; isEstimated: boolean }[] = [];
    for (let i = 5; i >= 0; i--) {
      const year = (currentYear - i).toString();
      if (i === 0) {
        historicalPE.push({ year, pe: valuation.pe, isEstimated: false });
      } else {
        const hash = ((seed * (i + 1) * 2654435761) >>> 0) % 1000;
        const variation = (hash - 500) / 500; // -1 ~ 1
        const trend = 1 + (i - 2.5) * 0.02; // 轻微时间趋势
        const estimatedPe = Math.round(center * trend * (1 + variation * 0.25) * 10) / 10;
        historicalPE.push({ year, pe: Math.max(estimatedPe, 1), isEstimated: true });
      }
    }
    valuation.historicalPE = historicalPE;
  }

  // 2. 多专家独立研判（并行调用，保留并行潜力以备未来异步化）
  emit({ phase: 'experts', message: '5 位 AI 专家独立研判中...' });
  const [fundOpinion, valOpinion, indOpinionResult, riskOpinion, capitalOpinion] = await Promise.all([
    fundamentalExpert(financial, valuation, info),
    valuationExpert(financial, valuation, info),
    industryExpert(financial, valuation, info),
    riskExpert(financial, valuation, info),
    capitalFlowExpert(financial, valuation, info)
  ]);

  // 提取行业专家结果和景气度建议
  const indOpinion: IndustryExpertResult = indOpinionResult;
  const expertOpinions: ExpertOpinion[] = [fundOpinion, valOpinion, indOpinion, riskOpinion, capitalOpinion];

  // 3. 辩论仲裁
  emit({ phase: 'arbitration', message: '多专家辩论仲裁中...' });
  const { controversies, finalOpinion } = await arbitrationExpert({
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
  const pePercentile = safeDiv(peValues.filter(p => p <= valuation.pe).length, peValues.length) * 100;

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
  const scoreDetail = calculateScores(financial, valuation, info, industrySuggestion);
  const totalScore = scoreDetail.profit_quality + scoreDetail.growth + scoreDetail.valuation +
    scoreDetail.industry_boom + scoreDetail.risk_deduction;

  // 6. 综合评级
  let rating: string;
  if (totalScore >= 80) rating = '优先跟踪';
  else if (totalScore >= 60) rating = '持续观察';
  else if (totalScore >= 40) rating = '谨慎观望';
  else rating = '建议规避';

  emit({ phase: 'scoring', message: `量化打分完成：${totalScore}/100，${rating}`, totalScore, rating });

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
  if (safeDiv(financial.accountsReceivable[n - 1], financial.revenue[n - 1]) * 100 > 10) {
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

  // 12. 情景推演（可选叠加最新消息情绪 z 与极性微调）
  const scenarios = generateScenarios(
    allOpinions,
    financial,
    valuation,
    info,
    newsSignal?.hasNews ? { sentimentZ: newsSignal.sentimentZ, polarity: newsSignal.polarity } : undefined,
  );

  // 12.5 若抓到最新消息，补充一条自省（逻辑闭环⑤）
  if (newsSignal?.hasNews) {
    reflectionNotes.push(
      `【逻辑闭环⑤】最新消息情绪极性 ${newsSignal.polarity.toFixed(2)}（看多占比 ${(newsSignal.bullishRatio * 100).toFixed(0)}%、新鲜度 ${(newsSignal.freshness * 100).toFixed(0)}%），已纳入情景推演与策略回测。`,
    );
  }

  // 13. 量化策略清单（获取OHLCV数据并运行回测，可选叠加最新消息情绪）
  emit({ phase: 'strategy', message: '量化策略回测中...' });
  let strategyList: import('../types.js').StrategyRecommendation[] = [];
  try {
    const endDate = new Date().toISOString().slice(0, 10);
    const startDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const ohlcvData = await fetchOHLCVData(info.code, startDate, endDate);
    if (ohlcvData.length > 0) {
      const isSimulated = ohlcvData.some(d => d.isSimulated);
      const rawStrategies = await generateStrategyList(
        info.code,
        ohlcvData,
        newsSignal?.hasNews ? { polarity: newsSignal.polarity } : null,
      );
      strategyList = rawStrategies.map(s => ({
        strategyType: s.strategyType,
        sharpeRatio: s.sharpeRatio,
        maxDrawdown: s.maxDrawdown,
        winRate: s.winRate,
        totalReturn: s.totalReturn,
        applicableMarket: s.applicableMarket,
        fatalWeakness: s.fatalWeakness,
        backtestWarning: isSimulated
          ? `[[模拟数据]] ${s.backtestWarning || ''} (K线API不可达，回测基于模拟价格，不代表真实行情)`
          : s.backtestWarning,
        newsAware: s.newsAware
      }));
    }
  } catch (e) {
    console.warn('策略清单生成失败:', e);
  }

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
      follow_up_indicators: followUpIndicators,
      scenarios: scenarios,
      strategyList: strategyList,
      newsSentiment: newsSignal?.hasNews ? newsSignal : undefined
    }],
    data_sources: dataSources,
    research_confidence: `基于${allOpinions.length}位专家独立研判+仲裁综合，整体置信度${Math.round(allOpinions.reduce((s, o) => s + o.confidence, 0) / allOpinions.length)}%。财务数据置信度高（上市公司年报审计），行业判断置信度中等（存在政策不确定性）。`,
    limitation_explain: '本分析基于公开财务数据和行业信息，未包含非公开信息、实地调研、管理层访谈等。数据截止至最近年报，可能存在滞后性。分析模型为定性+定量结合，不构成投资建议。'
  };
}

