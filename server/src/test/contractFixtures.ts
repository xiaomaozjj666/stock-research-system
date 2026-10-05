/**
 * 契约形状的测试夹具工厂
 * ============================================================================
 * 存在的理由：契约校验（test/contractSupertest.ts）接上后，暴露出大量路由测试的
 * **桩与真实结构不符** —— 典型写法是只造两三个字段再 `as never` / `as unknown as X`
 * 绕过类型检查。这类桩让测试「只验自己造的那几个字段」：真实结构改了，桩没跟上，
 * 测试照样绿。契约校验第一次把这件事摆到明面上。
 *
 * 这里提供**符合契约的完整形状**，让桩不再需要 `as never` 蒙混。
 * 用法：
 *   import { stockPoolItem, analysisResult } from '../test/contractFixtures.js';
 *   const res = { stock_pool: [stockPoolItem('600519', '贵州茅台')] };
 */

/** FinancialData 的 15 个必填序列字段 */
export function financialMetrics(): Record<string, unknown> {
  return {
    years: [],
    revenue: [],
    netProfit: [],
    grossMargin: [],
    netMargin: [],
    roe: [],
    operatingCashFlow: [],
    eps: [],
    totalAssets: [],
    totalLiabilities: [],
    equity: [],
    accountsReceivable: [],
    inventory: [],
    goodwill: [],
    debtRatio: [],
  };
}

/** ValuationData 的必填字段 */
export function valuationData(): Record<string, unknown> {
  return {
    currentPrice: 100,
    pe: 20,
    pb: 3,
    ps: 2,
    marketCap: 1000,
    historicalPE: [],
    peerComparison: [],
  };
}

/** ScoreDetail 的 5 个必填分项 */
export function scoreDetail(): Record<string, unknown> {
  return { profit_quality: 80, growth: 75, valuation: 70, industry_boom: 78, risk_deduction: 20 };
}

/**
 * StockPoolItem —— 契约里 14 个必填字段。
 * @param stock_code 6 位 A 股代码
 * @param stock_name 名称
 */
export function stockPoolItem(
  stock_code = '600519',
  stock_name = '贵州茅台',
): Record<string, unknown> {
  return {
    stock_code,
    stock_name,
    industry: '白酒',
    core_summary: '测试用核心结论',
    total_score: 82,
    rating: '优先跟踪',
    score_detail: scoreDetail(),
    strengths: ['盈利稳定'],
    risk_list: ['估值偏高'],
    controversy_points: [],
    finance_metrics: financialMetrics(),
    valuation: valuationData(),
    valuation_level: '合理',
    expert_opinions: [],
    reflection_notes: [],
    chart_list: [],
    follow_up_indicators: [],
  };
}

/** AnalysisResult（/api/analyze 的 200 响应体） */
export function analysisResult(
  stock_code = '600519',
  stock_name = '贵州茅台',
): Record<string, unknown> {
  return {
    generatedAt: '2026-09-16T00:00:00.000Z',
    stock_pool: [stockPoolItem(stock_code, stock_name)],
    data_sources: [],
    research_confidence: '测试置信度',
    limitation_explain: '测试局限性',
  };
}

/** DocumentInsight（/api/ingest 响应里的 insight） */
export function documentInsight(): Record<string, unknown> {
  return {
    summary: '测试摘要',
    positives: ['利好一'],
    risks: ['风险一'],
    catalysts: ['催化一'],
    confidence: 'medium',
    source: 'heuristic',
  };
}

/**
 * CompositeAlphaResult（/api/quant/factor/composite 的 200 响应体）。
 * `isSimulated` 必填：compositeService 无条件写入它。
 */
export function compositeAlphaResult(stock_code = '600519'): Record<string, unknown> {
  return {
    stockCode: stock_code,
    market: 'A',
    benchmarkSecid: '1.000300',
    horizons: [21, 63],
    compositeAlpha: {
      horizons: [],
      hasSignal: false,
      overallDirection: 'neutral',
      overallAlpha: 0,
    },
    factorPredictability: [],
    bars: 400,
    dataRange: { start: '2024-01-01', end: '2025-03-01' },
    benchmarkAvailable: true,
    isSimulated: false,
  };
}
