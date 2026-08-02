/**
 * 因子层（Factors）
 * --------------------------------------------------------------------------
 * 将财务/估值原始指标抽取为「因子」，并以文档化的逻辑斯蒂(logistic)函数归一化，
 * 替代原先散落的魔法斜率常量。每个因子声明方向(越高/越低越好)、中性点(neutral)
 * 与灵敏度(scale)，其「合意度」desirability = 1/(1+exp(-dir·(v-neutral)/scale)) ∈ [0,1]，
 * 在 neutral 处为 0.5，单调、有界、可解释。再经 logit 反变换得到组合用的 z 分数。
 *
 * 这一步是「评分/预测使用严格数学模型」的归一化基础；最优加权由 factorAnalytics
 * 的 selectOptimalFactors 完成。
 */
import type { FinancialData, ValuationData, StockInfo } from '../types.js';
import {
  safeDiv,
  calculateVolatility,
  safeCAGR,
  scoreDebtRisk,
  industryPEBenchmark,
} from './scoringBasis.js';

export type FactorDirection = 1 | -1; // 1=越高越好, -1=越低越好
export type FactorDimension = 'profit' | 'growth' | 'valuation' | 'industry' | 'risk';

export interface FactorDef {
  name: string;
  dimension: FactorDimension;
  direction: FactorDirection;
  /** 原始因子值 */
  value: number;
  /** 逻辑斯蒂中性点（desirability = 0.5 处） */
  neutral: number;
  /** 逻辑斯蒂灵敏度：偏离 neutral 达 scale 时 desirability≈0.88/0.12 */
  scale: number;
}

/** 逻辑斯蒂合意度：将原始值映射到 [0,1]，neutral 处为 0.5 */
export function normalizeFactor(
  value: number,
  direction: FactorDirection,
  neutral: number,
  scale: number,
): number {
  if (!isFinite(value) || !isFinite(scale) || scale === 0) return 0.5;
  const x = (direction * (value - neutral)) / scale;
  return 1 / (1 + Math.exp(-x));
}

/** logit 反变换：desirability ∈ (0,1) → z ∈ ℝ；d=0.5→0，单调。端点收敛到 ±∞。 */
export function desirabilityToZ(d: number): number {
  const lo = Math.min(0.999999, Math.max(0.000001, d));
  return Math.log(lo / (1 - lo));
}

const avg = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** 计算最新应收/营收占比(%) */
function arRatioPct(financial: FinancialData, idx: number): number {
  const rev = financial.revenue[idx];
  return rev !== 0 ? (financial.accountsReceivable[idx] / Math.abs(rev)) * 100 : 0;
}

/** 计算平均现金流/净利润（仅统计净利润为正的年份，亏损期该比率无意义） */
function avgCashFlowRatio(financial: FinancialData): number {
  const n = financial.years.length;
  let s = 0;
  let c = 0;
  for (let i = 0; i < n; i++) {
    if (financial.netProfit[i] > 0) {
      s += financial.operatingCashFlow[i] / financial.netProfit[i];
      c++;
    }
  }
  // 无正利润年份 → 返回 0（合意度中性，不虚增盈利质量）
  return c > 0 ? s / c : 0;
}

/** 营收同比增长率序列(%) */
function revenueGrowthRates(financial: FinancialData): number[] {
  const out: number[] = [];
  for (let i = 1; i < financial.revenue.length; i++) {
    const prev = Math.abs(financial.revenue[i - 1]);
    if (prev > 0) out.push(((financial.revenue[i] - financial.revenue[i - 1]) / prev) * 100);
  }
  return out;
}

/**
 * 抽取全部因子（五大维度）。中性点与灵敏度均为文档化域先验：
 *  - 毛利率 neutral 30%/scale 30 → 60% 视为优(≈0.88)、0% 视为差(≈0.12)
 *  - ROE neutral 10%/scale 15
 *  - 现金流质量 neutral 1.0（CF/NP≈1 理想）
 *  - 估值分位 neutral 50%/scale 35
 *  - 负债用行业基准折算后由 scoreDebtRisk 给出 0-7（neutral 3.5）
 */
export function extractFactors(
  financial: FinancialData,
  valuation: ValuationData,
  info: StockInfo,
): FactorDef[] {
  const n = financial.years.length;
  const idx = n - 1;

  // —— 盈利质量 ——
  const avgGM = avg(financial.grossMargin);
  const gmRange = Math.max(...financial.grossMargin) - Math.min(...financial.grossMargin);
  const cfr = avgCashFlowRatio(financial);
  const arRatio = arRatioPct(financial, idx);

  // —— 成长性 ——
  const revenueCAGR = safeCAGR(financial.revenue[0], financial.revenue[idx], n - 1);
  const profitCAGR = safeCAGR(financial.netProfit[0], financial.netProfit[idx], n - 1);
  const latestProfitGrowth = financial.netProfit[idx - 1] !== 0
    ? ((financial.netProfit[idx] - financial.netProfit[idx - 1]) / Math.abs(financial.netProfit[idx - 1])) * 100
    : 0;
  const revG = revenueGrowthRates(financial);
  const avgRevGrowth = revG.length ? avg(revG) : 0;
  const revGStd = revG.length
    ? Math.sqrt(revG.reduce((s, g) => s + (g - avgRevGrowth) ** 2, 0) / revG.length)
    : 0;
  const growthStabilityRaw = Math.max(0, 1 - Math.min(1, revGStd / 50)); // 0-1，越高越稳
  // 稳定性仅当平均营收增长为正时才视为加分项；平稳下滑不应获得成长稳定性加分
  const growthStability = avgRevGrowth > 0 ? growthStabilityRaw : 0;

  // —— 估值 ——
  const peValues = valuation.historicalPE.map((h) => h.pe).sort((a, b) => a - b);
  const pePercentile = peValues.length
    ? (peValues.filter((p) => p <= valuation.pe).length / peValues.length) * 100
    : 50;
  const hasPeer = valuation.peerComparison.length > 0;
  const peerAvgPE = hasPeer
    ? safeDiv(
        valuation.peerComparison.reduce((s, p) => s + p.pe, 0),
        valuation.peerComparison.length,
      )
    : valuation.pe;
  const peerPEratio = isFinite(peerAvgPE / valuation.pe) && valuation.pe > 0
    ? peerAvgPE / valuation.pe
    : 1;
  const benchmarkPE = industryPEBenchmark(info.industry);
  const peVsBenchmark = safeDiv(valuation.pe, benchmarkPE);
  const peg = latestProfitGrowth > 0 ? safeDiv(valuation.pe, latestProfitGrowth) : 1;
  const peSorted = [...peValues];
  const peMedian = peSorted.length ? peSorted[Math.floor(peSorted.length / 2)] : valuation.pe;
  const peMomentum = peMedian > 0 ? (peMedian - valuation.pe) / peMedian : 0;

  // —— 行业景气 ——
  const gmTrend = financial.grossMargin[idx] - financial.grossMargin[0];

  // —— 风险 ——
  const debtRiskScore = scoreDebtRisk(financial.debtRatio[idx], info.industry); // 0-7
  const goodwillRatio = financial.equity[idx] !== 0
    ? (financial.goodwill[idx] / Math.abs(financial.equity[idx])) * 100
    : 0;
  const arRisk = arRatioPct(financial, idx);
  const revVol = calculateVolatility(financial.revenue);
  const profitVol = calculateVolatility(financial.netProfit);
  const volatility = (revVol + profitVol) / 2;
  // 异常信号：应收暴增 + 现金流长期背离
  let anomalyRaw = 3;
  if (n >= 2 && financial.accountsReceivable[idx - 1] !== 0) {
    const arGrowth = ((financial.accountsReceivable[idx] - financial.accountsReceivable[idx - 1]) /
      Math.abs(financial.accountsReceivable[idx - 1])) * 100;
    if (arGrowth > revG[revG.length - 1] * 1.5 && arGrowth > 20) anomalyRaw -= 1.5;
  }
  const cfDivorce = financial.operatingCashFlow.filter((cf, i) =>
    financial.netProfit[i] !== 0 && isFinite(cf / financial.netProfit[i]) && cf < financial.netProfit[i] * 0.7,
  ).length;
  if (cfDivorce >= 3) anomalyRaw -= 1.5;
  const anomaly = Math.max(0, anomalyRaw); // 0-3，越高越干净

  return [
    // 盈利质量
    { name: 'grossMargin', dimension: 'profit', direction: 1, value: avgGM, neutral: 30, scale: 30 },
    { name: 'roe', dimension: 'profit', direction: 1, value: avg(financial.roe), neutral: 10, scale: 15 },
    { name: 'cashFlowRatio', dimension: 'profit', direction: 1, value: cfr, neutral: 1, scale: 1 },
    { name: 'arRatioProfit', dimension: 'profit', direction: -1, value: arRatio, neutral: 20, scale: 30 },
    { name: 'gmStability', dimension: 'profit', direction: -1, value: gmRange, neutral: 5, scale: 12 },
    // 成长性
    { name: 'revenueCAGR', dimension: 'growth', direction: 1, value: revenueCAGR, neutral: 10, scale: 15 },
    { name: 'profitCAGR', dimension: 'growth', direction: 1, value: profitCAGR, neutral: 12, scale: 18 },
    { name: 'latestProfitGrowth', dimension: 'growth', direction: 1, value: latestProfitGrowth, neutral: 10, scale: 20 },
    { name: 'growthStability', dimension: 'growth', direction: 1, value: growthStability, neutral: 0.5, scale: 0.5 },
    // 估值
    { name: 'pePercentile', dimension: 'valuation', direction: -1, value: pePercentile, neutral: 50, scale: 35 },
    { name: 'peerPEratio', dimension: 'valuation', direction: 1, value: peerPEratio, neutral: 1, scale: 0.5 },
    { name: 'peVsBenchmark', dimension: 'valuation', direction: -1, value: peVsBenchmark, neutral: 1, scale: 0.6 },
    { name: 'peg', dimension: 'valuation', direction: -1, value: peg, neutral: 1, scale: 1 },
    { name: 'peMomentum', dimension: 'valuation', direction: 1, value: peMomentum, neutral: 0, scale: 0.3 },
    // 行业景气
    { name: 'avgRevenueGrowth', dimension: 'industry', direction: 1, value: avgRevGrowth, neutral: 10, scale: 15 },
    { name: 'gmTrend', dimension: 'industry', direction: 1, value: gmTrend, neutral: 0, scale: 5 },
    // 风险（因子值越高代表风险越低 → direction +1）
    { name: 'debtRiskScore', dimension: 'risk', direction: 1, value: debtRiskScore, neutral: 3.5, scale: 3.5 },
    { name: 'goodwillRatio', dimension: 'risk', direction: -1, value: goodwillRatio, neutral: 10, scale: 30 },
    { name: 'arRatioRisk', dimension: 'risk', direction: -1, value: arRisk, neutral: 20, scale: 30 },
    { name: 'volatility', dimension: 'risk', direction: -1, value: volatility, neutral: 0.2, scale: 0.5 },
    { name: 'anomalyScore', dimension: 'risk', direction: 1, value: anomaly, neutral: 1.5, scale: 1.5 },
  ];
}

export const FACTOR_DIMENSIONS: FactorDimension[] = [
  'profit', 'growth', 'valuation', 'industry', 'risk',
];

/**
 * 将因子转为组合用的 z 分数。
 *  - 默认：每个因子的合意度经 logit 反变换得到 z（文档化、有界、单调）。
 *  - 若提供某因子的截面样本 crossSection[name]（含本股票值），则改用截面 z
 *    标准化（(v - μ)/σ），更严谨地刻画「相对同业」位置。
 */
export function buildFactorZScores(
  factors: FactorDef[],
  crossSection?: Record<string, number[]>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of factors) {
    const peers = crossSection?.[f.name];
    if (peers && peers.length > 0) {
      const all = [f.value, ...peers];
      const mean = avg(all);
      const variance = all.reduce((s, v) => s + (v - mean) ** 2, 0) / all.length;
      const std = Math.sqrt(variance);
      out[f.name] = std > 0 ? (f.value - mean) / std : 0;
    } else {
      const d = normalizeFactor(f.value, f.direction, f.neutral, f.scale);
      out[f.name] = desirabilityToZ(d);
    }
  }
  return out;
}

/** 按维度分组因子 */
export function groupFactorsByDimension(
  factors: FactorDef[],
): Record<FactorDimension, FactorDef[]> {
  const grouped = {
    profit: [], growth: [], valuation: [], industry: [], risk: [],
  } as Record<FactorDimension, FactorDef[]>;
  for (const f of factors) grouped[f.dimension].push(f);
  return grouped;
}
