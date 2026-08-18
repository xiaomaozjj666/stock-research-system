/**
 * 风险归因（Risk Attribution）
 * --------------------------------------------------------------------------
 * 借鉴 Goldman Sachs GS Quant 的 RiskModel 思路：把个股风险分解为
 *   1. 风格因子暴露（规模/价值/动量/盈利/杠杆）——标准化后的因子载荷；
 *   2. 系统风险（因子暴露驱动的波动）与特异风险（残差波动）三分量分解。
 *
 * 当前为轻量版：无截面时使用行业固定基准（均值/标准差常量）标准化；
 * 因子波动率使用经验常量，不引入协方差矩阵（与免费数据源的能力匹配）。
 * 所有函数纯函数、无副作用，可独立测试与离线校准复用。
 */

/** 风格因子暴露剖面（z 分数：>0 表示暴露高于基准） */
export interface StyleExposures {
  size: number;
  value: number;
  momentum: number;
  profitability: number;
  leverage: number;
}

/** 风险分解（年化波动率口径，单位：%） */
export interface RiskDecomposition {
  /** 系统风险（因子暴露解释的部分） */
  systematicVol: number;
  /** 特异风险（残差部分） */
  specificVol: number;
  /** 总波动 = sqrt(systematic² + specific²) */
  totalVol: number;
  /** 系统风险占比 = systematic² / total² ∈ [0,1] */
  explainedRatio: number;
}

/** 风格因子输入（原始量纲） */
export interface FactorInput {
  marketCap?: number; // 亿元
  pe?: number;
  /** 近 N 月动量（如 0.12 = +12%） */
  momentum?: number;
  roe?: number; // 百分数（如 25 = 25%）
  debtRatio?: number; // 百分数（如 45 = 45%）
}

/** 截面基准（均值/标准差）；缺省为 A 股经验固定基准 */
export interface CrossSectionStats {
  mean: FactorInput;
  std: FactorInput;
}

/** 经验固定基准（A 股风格因子，校准自公开截面统计） */
const DEFAULT_BENCHMARK: CrossSectionStats = {
  mean: { marketCap: 150, pe: 30, momentum: 0.08, roe: 10, debtRatio: 45 },
  std: { marketCap: 180, pe: 25, momentum: 0.25, roe: 8, debtRatio: 22 },
};

/** 因子年化波动率经验常量（%）：规模/价值/动量/盈利/杠杆 */
const FACTOR_VOLATILITY = [12, 18, 22, 14, 10] as const;

/** z 标准化：缺失输入返回 0（中性暴露） */
function zScore(value: number | undefined, mean: number, std: number): number {
  if (value === undefined || !Number.isFinite(value) || std <= 0) return 0;
  return (value - mean) / std;
}

/**
 * 计算个股对 5 个风格因子的暴露（z 分数）。
 * 提供 crossSection 时按截面标准化；缺省用经验固定基准。
 */
export function styleFactorExposures(
  input: FactorInput,
  crossSection?: CrossSectionStats,
): StyleExposures {
  const bm = crossSection ?? DEFAULT_BENCHMARK;
  // 局部变量：让 TS 完成可选字段收窄（对象字面量内多次访问不会收窄）
  const meanPe = bm.mean.pe;
  const stdPe = bm.std.pe;
  const meanCap = bm.mean.marketCap;
  const stdCap = bm.std.marketCap;
  return {
    // 规模：log(市值) 缩小量纲后标准化（大市值 → 高暴露）
    size:
      input.marketCap !== undefined &&
      meanCap !== undefined &&
      meanCap > 0 &&
      stdCap !== undefined &&
      stdCap > 0
        ? (Math.log(Math.max(input.marketCap, 1)) - Math.log(meanCap)) / Math.log(stdCap)
        : 0,
    // 价值：1/PE（低 PE = 高价值暴露）
    value:
      input.pe !== undefined &&
      input.pe > 0 &&
      meanPe !== undefined &&
      meanPe > 0 &&
      stdPe !== undefined &&
      stdPe > 0
        ? (1 / input.pe - 1 / meanPe) / (1 / meanPe - 1 / (meanPe + stdPe))
        : 0,
    // 动量：近期收益直接标准化
    momentum: zScore(input.momentum, bm.mean.momentum ?? 0, bm.std.momentum ?? 1),
    // 盈利：ROE 标准化
    profitability: zScore(input.roe, bm.mean.roe ?? 0, bm.std.roe ?? 1),
    // 杠杆：负债率标准化（高负债 → 高杠杆暴露）
    leverage: zScore(input.debtRatio, bm.mean.debtRatio ?? 0, bm.std.debtRatio ?? 1),
  };
}

/**
 * 风险分解：给定风格因子暴露与因子波动率，计算系统/特异/总波动。
 * 假设因子间独立（轻量近似），特异波动由调用方提供（如残差收益波动）。
 */
export function decomposeRisk(
  exposures: StyleExposures,
  specificVol: number,
  factorVols: readonly number[] = FACTOR_VOLATILITY,
): RiskDecomposition {
  const exp = [
    exposures.size,
    exposures.value,
    exposures.momentum,
    exposures.profitability,
    exposures.leverage,
  ];
  const sys2 = exp.reduce((s, e, i) => s + (e * factorVols[i]) ** 2, 0);
  const spec2 = (specificVol >= 0 ? specificVol : 0) ** 2;
  const total = Math.sqrt(sys2 + spec2);
  return {
    systematicVol: Math.round(Math.sqrt(sys2) * 100) / 100,
    specificVol: Math.round(Math.sqrt(spec2) * 100) / 100,
    totalVol: Math.round(total * 100) / 100,
    explainedRatio: total > 0 ? Math.round((sys2 / (sys2 + spec2)) * 1000) / 1000 : 0,
  };
}
