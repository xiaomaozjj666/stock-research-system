/**
 * ARIMA(p, d, 0)：差分 + 自回归，条件最小二乘估计。
 * ============================================================================
 * 口径说明：这里实现的是 ARIMA 的「I − AR」主干——先差分 d 次消除单位根，
 * 再对差分序列拟合 AR(p)（含常数项，即带漂移的 ARIMA），p 由 AIC/BIC 在
 * [0, pMax] 内自动选择，并对残差做 Ljung-Box 白噪声诊断。
 *
 * 刻意不实现 MA(q>0) 项：日频金融收益/差分价差序列的 MA 成分通常很弱
 * （微观结构噪声才显著），AR 主干已覆盖因子研究的绝大部分需求；而 MA 项的
 * 精确 MLE 需要状态空间滤波，复杂度与收益不成比例。需要完整 ARMA 时再引入
 * 状态空间框架（与 kalman.ts 共享基底）。
 *
 * Ljung-Box：Q(h) = T(T+2) Σ_{k≤h} ρ̂²_k/(T−k)，H0 = 残差无自相关。
 * p 值用 Wilson–Hilferty 变换把 χ²(df) 近似为正态（df≥3 时误差很小），
 * 自由度取 h − p（扣掉已拟合的 AR 阶数）。
 *
 * 全部纯函数、确定性、无第三方依赖。
 */

import { olsWithStats } from './linalg.js';
import { adfTest } from './adf.js';

export interface ArimaFit {
  /** 差分阶数 */
  d: number;
  /** 选中的 AR 阶数 */
  p: number;
  /** 拟合用的差分序列长度 */
  nobs: number;
  /** AR 系数 φ_1..φ_p 与常数项 c（系数数组第一位为 c） */
  coefficients: { constant: number; phi: number[] };
  stdErrors: { constant: number; phi: number[] };
  residuals: number[];
  aic: number;
  bic: number;
  /** 残差 Ljung-Box 诊断 */
  ljungBox: { q: number; df: number; pValue: number; lags: number };
  /** 定阶过程的 AIC/BIC 轨迹（诊断用） */
  selection: { lag: number; aic: number; bic: number }[];
  /** d 未显式给出时给出的单位根诊断（对原始序列的 ADF） */
  unitRootHint: { statistic: number; rejectAt5: boolean } | null;
}

/** 差分 d 次 */
export function differenceSeries(x: number[], d: number): number[] {
  let out = x.slice();
  for (let i = 0; i < d; i++) {
    if (out.length < 2) throw new Error(`序列过短，无法做 ${d} 阶差分`);
    out = out.slice(1).map((v, j) => v - out[j]);
  }
  return out;
}

/** 拟合固定阶 AR(p)（含常数项），返回系数/残差/SSR */
function fitAr(
  diff: number[],
  p: number,
): {
  constant: number;
  phi: number[];
  se: { constant: number; phi: number[] };
  residuals: number[];
  ssr: number;
  nobs: number;
} | null {
  const nobs = diff.length - p;
  if (nobs < 10) return null;
  const cols: number[][] = [];
  for (let l = 1; l <= p; l++) {
    cols.push(diff.slice(p - l, diff.length - l));
  }
  const target = diff.slice(p);
  const fit = olsWithStats(target, cols, true);
  const phi = fit.coefficients.slice(1);
  const sePhi = fit.stdErrors.slice(1);
  let ssr = 0;
  for (const r of fit.residuals) ssr += r * r;
  return {
    constant: fit.coefficients[0],
    phi,
    se: { constant: fit.stdErrors[0], phi: sePhi },
    residuals: fit.residuals,
    ssr: Math.max(ssr, 1e-300),
    nobs,
  };
}

/** Wilson–Hilferty 近似 χ² 上尾 p 值 */
function chiSquareUpperTail(q: number, df: number): number {
  if (df <= 0) return NaN;
  const z = (Math.pow(q / df, 1 / 3) - (1 - 2 / (9 * df))) / Math.sqrt(2 / (9 * df));
  // 标准正态上尾
  const cdf = 0.5 * (1 + erf(z / Math.SQRT2));
  return Math.max(1e-6, Math.min(1, 1 - cdf));
}

/** Abramowitz–Stegun 7.1.26 近似 erf（|ε| < 1.5e-7） */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

/**
 * 拟合 ARIMA(p, d, 0)。
 * @param series 原始序列（价格或收益）
 * @param opts.d 差分阶数（默认 1，价格序列常用）；传 0 拟合 AR(p) 于原序列
 * @param opts.pMax AR 阶数上限（默认 3，≤8）
 * @param opts.criterion 'aic'（默认）或 'bic'
 */
export function fitArima(
  series: number[],
  opts: { d?: number; pMax?: number; criterion?: 'aic' | 'bic' } = {},
): ArimaFit {
  const d = opts.d ?? 1;
  const pMax = Math.max(0, Math.min(opts.pMax ?? 3, 8));
  if (series.length < 40 + d + pMax) {
    throw new Error(`ARIMA 需要至少 ${40 + d + pMax} 个观测，当前 ${series.length}`);
  }

  // 单位根提示：对原始序列做 ADF，帮助判断 d 的选择是否合理
  const hint = adfTest(series, { spec: 'c' });
  const unitRootHint = { statistic: hint.statistic, rejectAt5: hint.rejectAt5 };

  const diff = differenceSeries(series, d);
  const selection: { lag: number; aic: number; bic: number }[] = [];
  let bestP = 0;
  let bestScore = Infinity;
  let bestFit: ReturnType<typeof fitAr> | null = null;

  for (let p = 0; p <= pMax; p++) {
    const f = fitAr(diff, p);
    if (!f) continue;
    const k = p + 2; // 常数 + φ_p + σ²
    const aic = f.nobs * Math.log(f.ssr / f.nobs) + 2 * k;
    const bic = f.nobs * Math.log(f.ssr / f.nobs) + Math.log(f.nobs) * k;
    selection.push({ lag: p, aic, bic });
    const score = (opts.criterion ?? 'aic') === 'bic' ? bic : aic;
    if (score < bestScore) {
      bestScore = score;
      bestP = p;
      bestFit = f;
    }
  }
  if (!bestFit) {
    throw new Error('ARIMA 拟合失败：有效样本不足（差分后观测过少）');
  }

  // Ljung-Box：滞后数 h = min(10, nobs/5)，df = h − p
  const res = bestFit.residuals;
  const nobs = res.length;
  const h = Math.max(3, Math.min(10, Math.floor(nobs / 5)));
  // 样本自相关
  const mean = res.reduce((a, b) => a + b, 0) / nobs;
  const denom = res.reduce((a, b) => a + (b - mean) * (b - mean), 0);
  let q = 0;
  for (let k = 1; k <= h; k++) {
    let num = 0;
    for (let t = k; t < nobs; t++) num += (res[t] - mean) * (res[t - k] - mean);
    const rho = denom > 0 ? num / denom : 0;
    q += (rho * rho) / (nobs - k);
  }
  q *= nobs * (nobs + 2);
  const df = Math.max(h - bestP, 1);

  return {
    d,
    p: bestP,
    nobs,
    coefficients: { constant: bestFit.constant, phi: bestFit.phi },
    stdErrors: { constant: bestFit.se.constant, phi: bestFit.se.phi },
    residuals: res,
    aic: selection.find((s) => s.lag === bestP)?.aic ?? NaN,
    bic: selection.find((s) => s.lag === bestP)?.bic ?? NaN,
    ljungBox: { q, df, pValue: chiSquareUpperTail(q, df), lags: h },
    selection,
    unitRootHint,
  };
}

/** 一步前瞻预测：ŷ_{T+1} = c + Σ φ_i·y_{T+1−i}（差分口径） */
export function arimaForecastOneStep(fit: ArimaFit, series: number[]): number {
  const diff = differenceSeries(series, fit.d);
  let pred = fit.coefficients.constant;
  for (let i = 1; i <= fit.p; i++) {
    pred += fit.coefficients.phi[i - 1] * (diff[diff.length - i] ?? 0);
  }
  // 还原到原始量纲：y_{T+1} = y_T + Δŷ（d=1）；d=0 直接是水平值
  if (fit.d === 1) return series[series.length - 1] + pred;
  if (fit.d === 0) return pred;
  // d≥2 的多步还原需要中间水平，这里不支持（价格序列 d=1 足够）
  throw new Error(`一步预测还原仅支持 d≤1，当前 d=${fit.d}`);
}
