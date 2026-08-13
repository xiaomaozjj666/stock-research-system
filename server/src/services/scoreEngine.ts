/**
 * 量化打分引擎（重构版）
 * --------------------------------------------------------------------------
 * 五维度打分（盈利质量/成长性/估值/行业景气/风险）现在建立在 factorAnalytics
 * 的最优加权框架之上：
 *   1. extractFactors 抽取原始因子（见 factors.ts），每个因子以文档化逻辑斯蒂
 *      函数归一化，消除原先散落的魔法斜率常量；
 *   2. buildFactorZScores 将因子转为组合用 z 分数——有同业截面时采用截面 z 标准化
 *      （更严谨的「相对同业」位置），否则用 logit(合意度)；
 *   3. 每个维度内对因子 z 按权重加权合成（compositeZ），再 zToScore 映射到 0-20。
 *
 * 权重默认采用维度内等权（域先验）。当调用方提供由 validateFactorModel /
 * selectOptimalFactors 估计的「最优权重」(factorWeights) 时，自动切换为
 * IR 最优加权——实现「所选因子必须最优」的可插拔机制。
 *
 * 从 analysisPipeline 抽取，保持 calculateScores 签名稳定，可独立测试。
 */
import type { FinancialData, ValuationData, StockInfo, ScoreDetail } from '../types.js';
import {
  safeDiv,
  scoreDebtRisk,
  INDUSTRY_PE_BENCHMARK,
  industryPEBenchmark,
} from './scoringBasis.js';
import {
  extractFactors,
  buildFactorZScores,
  groupFactorsByDimension,
  type FactorDef,
  type FactorDimension,
} from './factors.js';
import { compositeZ, zToScore } from '../quant/factorAnalytics.js';

// 与历史 scoreEngine.test.ts 兼容：继续从本模块导出基准符号
export { scoreDebtRisk, INDUSTRY_PE_BENCHMARK };

export interface ScoreOptions {
  /**
   * 因子最优权重（由 IC/IR 校准得到）。键为因子名，值为权重。
   * 提供时按 IR 最优加权；缺失因子按等权补足，未命中因子忽略。
   */
  factorWeights?: Record<string, number>;
  /** 估值因子可用的同业截面样本（因子名 → 同业原始值数组），用于截面 z 标准化 */
  valuationCrossSection?: Record<string, number[]>;
}

const DIMENSION_MAX = 20;

/** 等权（维度内每个因子权重=1，compositeZ 会归一化） */
function equalWeights(factors: FactorDef[]): Record<string, number> {
  const w: Record<string, number> = {};
  for (const f of factors) w[f.name] = 1;
  return w;
}

/** 在给定权重中挑选本维度因子的权重（缺失则等权） */
function resolveWeights(
  factors: FactorDef[],
  optimal?: Record<string, number>,
): Record<string, number> {
  if (!optimal) return equalWeights(factors);
  const picked: Record<string, number> = {};
  let any = false;
  for (const f of factors) {
    if (optimal[f.name] !== undefined && isFinite(optimal[f.name]) && optimal[f.name] > 0) {
      picked[f.name] = optimal[f.name];
      any = true;
    }
  }
  return any ? picked : equalWeights(factors);
}

/** 单维度组合→0-20 分 */
function dimensionScore(
  dimension: FactorDimension,
  grouped: Record<FactorDimension, FactorDef[]>,
  zByFactor: Record<string, number>,
  optimal?: Record<string, number>,
): number {
  const fs = grouped[dimension];
  if (fs.length === 0) return 0;
  const z = compositeZ(zByFactor, resolveWeights(fs, optimal));
  return zToScore(z, DIMENSION_MAX);
}

export function calculateScores(
  financial: FinancialData,
  valuation: ValuationData,
  info: StockInfo,
  industryScoreSuggestion?: number,
  opts: ScoreOptions = {},
): ScoreDetail {
  const n = financial.years.length;

  const factors = extractFactors(financial, valuation, info);
  const grouped = groupFactorsByDimension(factors);

  // 估值因子若有同业截面（如 ROE），则走截面 z 标准化，更严谨
  const crossSection = opts.valuationCrossSection ?? buildValuationCrossSection(valuation);
  const zByFactor = buildFactorZScores(factors, crossSection);

  const optimal = opts.factorWeights;

  // === 盈利质量 (0-20) ===
  const profit_quality = dimensionScore('profit', grouped, zByFactor, optimal);

  // === 成长性 (0-20) ===
  const growth = dimensionScore('growth', grouped, zByFactor, optimal);

  // === 估值性价比 (0-20) ===
  const valuationScore = dimensionScore('valuation', grouped, zByFactor, optimal);

  // === 风险水平 (0-20，分越高风险越低) ===
  const risk_deduction = dimensionScore('risk', grouped, zByFactor, optimal);

  // === 行业景气度 (0-20) ===
  let industry_boom: number;
  if (typeof industryScoreSuggestion === 'number') {
    // 行业专家量化建议（已是 0-20 分数）
    industry_boom = Math.max(0, Math.min(DIMENSION_MAX, Math.round(industryScoreSuggestion)));
  } else {
    industry_boom = dimensionScore('industry', grouped, zByFactor, optimal);
  }

  // 防御性夹紧（理论上 zToScore 已保证，这里兜底非有限值）
  const clamp = (v: number) =>
    isFinite(v) ? Math.max(0, Math.min(DIMENSION_MAX, Math.round(v))) : 0;
  void n; // 保留 n 以备未来维度内时间加权
  return {
    profit_quality: clamp(profit_quality),
    growth: clamp(growth),
    valuation: clamp(valuationScore),
    industry_boom: clamp(industry_boom),
    risk_deduction: clamp(risk_deduction),
  };
}

/**
 * 从同业对比构造估值因子的截面样本（用于更严谨的截面 z 标准化）。
 * 目前 peers 提供 roe，因此仅对 roe 因子提供截面；其余估值因子走 logit 路径。
 */
function buildValuationCrossSection(valuation: ValuationData): Record<string, number[]> {
  const roes = valuation.peerComparison.map((p) => p.roe).filter((v) => isFinite(v));
  return roes.length > 0 ? { roe: roes } : {};
}

/** 行业 PE 基准查询（未知行业回落默认 20） */
export function benchmarkPEFor(industry: string): number {
  return industryPEBenchmark(industry);
}

// 兼容：保留 calculateVolatility / safeCAGR 的对外可用入口（实现已移入 scoringBasis）
export { safeDiv };
