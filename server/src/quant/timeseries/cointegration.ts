/**
 * 协整与配对交易统计：Engle-Granger 两步法。
 * ============================================================================
 * 两只价格序列都是 I(1)（各自有单位根）时，若它们的某个线性组合是 I(0)
 * （平稳），则称二者协整——价差会均值回复，为配对交易提供统计基础。
 *
 * Engle & Granger (1987) 两步法：
 *   1. 静态回归 y_t = a + β·x_t + s_t（β 即对冲比率，s 为价差）；
 *   2. 对残差 s 做 ADF（无常数项设定），但临界值不能再用标准 ADF 表——
 *      因为 β 是估计出来的，检验分布整体左移，需用 Engle-Granger 响应面临界值。
 *      这里取双变量（k=2）情形的渐近值：1%: −3.90 / 5%: −3.34 / 10%: −3.04。
 *
 * 均值回复速度：把价差当 OU 过程近似，Δs_t = φ·s_{t-1} + u_t，
 * 半衰期 = −ln2 / ln(1+φ)（交易日）。φ ≥ 0 说明价差无均值回复，配对前提不成立。
 *
 * 交易口径（统计描述，不构成回测）：价差 z-score = (s − mean(s)) / std(s)，
 * 常用 |z| > 2 进入、z 回到 0 附近退出的阈值规则；半衰期决定了持有周期量级。
 *
 * 全部纯函数、确定性、无第三方依赖。
 */

import { adfTest, type AdfSpec } from './adf.js';
import { olsWithStats } from './linalg.js';

/** Engle-Granger 双变量（无常数项）渐近临界值：1% / 5% / 10% */
export const EG_CRITICAL_VALUES_2VAR = {
  '1%': -3.9,
  '5%': -3.34,
  '10%': -3.04,
} as const;

export interface CointegrationResult {
  /** 对冲比率 β（y 对 x 的静态回归系数） */
  hedgeRatio: number;
  intercept: number;
  /** 第一步回归的 R² */
  r2: number;
  /** 残差 ADF 检验结果（spec='n'，临界值为 EG 口径） */
  residualAdf: {
    statistic: number;
    lag: number;
    nobs: number;
    criticalValues: Record<'1%' | '5%' | '10%', number>;
    pValue: number;
    rejectAt5: boolean;
  };
  /** 是否在 5% 水平判定协整 */
  cointegratedAt5: boolean;
  /** 价差序列（残差） */
  spread: number[];
  /** 价差 z-score 序列 */
  zScore: number[];
  /** 最新一日 z-score（|z|>2 通常视为偏离阈值） */
  latestZ: number;
  /** 价差均值回复半衰期（交易日）；无均值回复时为 Infinity */
  halfLife: number;
  /** 半衰期回归的 φ（Δs 对 s_{t-1}），≥0 即无均值回复 */
  ar1Phi: number;
  /** 建议的前提检查（两条序列应各自存在单位根） */
  note: string;
}

/**
 * Engle-Granger 协整检验 + 配对统计。
 * @param y 因变量价格序列（与 x 等长、按日期对齐）
 * @param x 自变量价格序列
 */
export function engleGranger(
  y: number[],
  x: number[],
  opts: { adfMaxLag?: number; adfCriterion?: 'aic' | 'bic' } = {},
): CointegrationResult {
  if (y.length !== x.length) {
    throw new Error(`y 与 x 长度不一致：${y.length} vs ${x.length}`);
  }
  if (y.length < 60) {
    throw new Error(`协整检验需要至少 60 个对齐观测，当前 ${y.length}`);
  }

  // 第一步：静态回归 → 对冲比率与价差
  const fit = olsWithStats(y, [x], true);
  const hedgeRatio = fit.coefficients[1];
  const intercept = fit.coefficients[0];
  const spread = fit.residuals;

  // 第二步：残差 ADF（无常数项；残差已近似零均值）
  const adf = adfTest(spread, {
    spec: 'n' as AdfSpec,
    maxLag: opts.adfMaxLag,
    criterion: opts.adfCriterion ?? 'aic',
  });

  // OU 近似半衰期：Δs_t = φ·s_{t-1} + u（无常数项）
  const sLag = spread.slice(0, -1);
  const dS = spread.slice(1).map((v, i) => v - sLag[i]);
  const ar1 = olsWithStats(dS, [sLag], false);
  const phi = ar1.coefficients[0];
  const halfLife = phi < -1e-8 ? -Math.log(2) / Math.log(1 + phi) : Infinity;

  // z-score（全样本口径）
  const m = spread.reduce((a, b) => a + b, 0) / spread.length;
  const sd = Math.sqrt(
    spread.reduce((a, b) => a + (b - m) * (b - m), 0) / Math.max(spread.length - 1, 1),
  );
  const zScore = spread.map((s) => (sd > 0 ? (s - m) / sd : 0));

  return {
    hedgeRatio,
    intercept,
    r2: fit.r2,
    residualAdf: {
      statistic: adf.statistic,
      lag: adf.lag,
      nobs: adf.nobs,
      criticalValues: { ...EG_CRITICAL_VALUES_2VAR },
      pValue: adf.pValue,
      rejectAt5: adf.statistic < EG_CRITICAL_VALUES_2VAR['5%'],
    },
    cointegratedAt5: adf.statistic < EG_CRITICAL_VALUES_2VAR['5%'],
    spread,
    zScore,
    latestZ: zScore[zScore.length - 1],
    halfLife,
    ar1Phi: phi,
    note:
      '两步法以「两序列均为 I(1)」为前提；正式结论前建议先对各自价格序列跑 ADF 确认单位根，' +
      '并注意协整关系可能随样本区间漂移（结构性断点会使历史 β 失效）。',
  };
}
