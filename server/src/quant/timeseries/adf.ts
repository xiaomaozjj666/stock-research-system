/**
 * Augmented Dickey-Fuller（ADF）单位根检验。
 * ============================================================================
 * 回归式（以带漂移项为例）：
 *   Δy_t = a + ρ·y_{t-1} + Σ_{i=1..k} γ_i·Δy_{t-i} + ε_t
 * H0: y 有单位根（ρ = 0）；t 统计量 = ρ̂ / se(ρ̂)，足够负则拒绝 H0（序列平稳）。
 *
 * 滞后阶 k 的选择：
 *   - 上限走 Schwert 规则 maxLag = floor(12·(n/100)^0.25)（可覆盖）；
 *   - 在 [0, maxLag] 内按 AIC / BIC（默认 AIC）自动选阶，参照 statsmodels 的 autolag 思路。
 *
 * p 值与临界值：t 统计量在 H0 下服从非标准 Dickey-Fuller 分布。这里使用
 * Fuller(1996)/MacKinnon 的渐近临界值（1%/5%/10%），p 值以临界值锚点做对数线性
 * 插值近似。渐近值在样本较短（T < 100）时偏乐观，输出里保留了 nobs 供自行判断；
 * 需要精确推断时请对照 MacKinnon 有限样本临界值表。
 *
 * 三种设定（spec）：
 *   'n'  — 无常数项（残差/去均值序列用）；
 *   'c'  — 常数项（默认，原始价格/收益序列用）；
 *   'ct' — 常数项 + 线性趋势。
 *
 * 全部纯函数、确定性、无第三方依赖。
 */

import { olsWithStats } from './linalg.js';

export type AdfSpec = 'n' | 'c' | 'ct';

/** Fuller/MacKinnon 渐近临界值（1% / 5% / 10%），按 spec 索引 */
const ASYMPTOTIC_CV: Record<AdfSpec, [number, number, number]> = {
  n: [-2.58, -1.95, -1.62],
  c: [-3.43, -2.86, -2.57],
  ct: [-3.96, -3.41, -3.13],
};

export interface AdfResult {
  /** t 统计量（越负越倾向拒绝单位根） */
  statistic: number;
  /** 实际使用的滞后阶数 */
  lag: number;
  /** 有效回归样本量 */
  nobs: number;
  spec: AdfSpec;
  /** { '1%': …, '5%': …, '10%': … } */
  criticalValues: Record<'1%' | '5%' | '10%', number>;
  /** 渐近 p 值（对数线性插值近似），精确推断请对照 MacKinnon 表 */
  pValue: number;
  /** 是否在 5% 水平拒绝单位根 */
  rejectAt5: boolean;
  /** 定阶依据与各阶信息准则（诊断用） */
  lagSelection: {
    criterion: 'aic' | 'bic';
    maxLag: number;
    scores: { lag: number; score: number }[];
  };
}

/** Schwert 规则：滞后上限 = floor(12·(n/100)^0.25)，夹在 [0, n/2 − 2] 内 */
export function schwertMaxLag(n: number): number {
  const v = Math.floor(12 * Math.pow(n / 100, 0.25));
  return Math.max(0, Math.min(v, Math.floor(n / 2) - 2));
}

/**
 * 对数线性插值近似 p 值：以 (1%, 5%, 10%) 临界值为锚点，锚点间线性插值，
 * 左尾/右尾按对数斜率外推，截断到 (1e-4, 1)。
 */
function pValueFromAnchors(stat: number, cv: [number, number, number]): number {
  const anchors: { x: number; p: number }[] = [
    { x: cv[0], p: 0.01 },
    { x: cv[1], p: 0.05 },
    { x: cv[2], p: 0.1 },
  ];
  if (stat <= anchors[0].x) {
    // 左尾外推：dlnp/dx 用最左段的斜率
    const slope = Math.log(0.05 / 0.01) / (anchors[1].x - anchors[0].x);
    const p = 0.01 * Math.exp(slope * (stat - anchors[0].x));
    return Math.max(p, 1e-4);
  }
  if (stat >= anchors[2].x) {
    const slope = Math.log(0.1 / 0.05) / (anchors[2].x - anchors[1].x);
    const p = Math.min(1, 0.1 * Math.exp(slope * (stat - anchors[2].x)));
    return p;
  }
  for (let i = 0; i < anchors.length - 1; i++) {
    const a = anchors[i];
    const b = anchors[i + 1];
    if (stat >= a.x && stat < b.x) {
      const t = (stat - a.x) / (b.x - a.x);
      return Math.exp(Math.log(a.p) + t * (Math.log(b.p) - Math.log(a.p)));
    }
  }
  return 0.1;
}

/**
 * 跑一次固定滞后阶的 ADF 回归，返回 t 统计量（内部函数，供选阶循环复用）。
 * predictors 依次为：y_{t-1}、（趋势项 ct）、Δy_{t-1..k}。
 */
function adfRegression(
  y: number[],
  spec: AdfSpec,
  lag: number,
): { statistic: number; nobs: number } {
  const n = y.length;
  const effective = n - lag - 1;
  const regressors: number[][] = [];
  // y_{t-1}
  const level: number[] = new Array<number>(effective);
  for (let i = 0; i < effective; i++) level[i] = y[lag + i];
  regressors.push(level);
  // ct：线性趋势（0,1,2,…）
  if (spec === 'ct') {
    const trend: number[] = new Array<number>(effective);
    for (let i = 0; i < effective; i++) trend[i] = i;
    regressors.push(trend);
  }
  // Δy_{t-1..lag}
  const diff: number[] = new Array<number>(n - 1);
  for (let i = 0; i < n - 1; i++) diff[i] = y[i + 1] - y[i];
  for (let l = 1; l <= lag; l++) {
    const col: number[] = new Array<number>(effective);
    for (let i = 0; i < effective; i++) col[i] = diff[lag + i - l];
    regressors.push(col);
  }
  // 被解释变量 Δy_t
  const dy: number[] = new Array<number>(effective);
  for (let i = 0; i < effective; i++) dy[i] = diff[lag + i];

  const fit = olsWithStats(dy, regressors, spec !== 'n');
  // ρ 的 t 统计量：ρ 在系数中的位置取决于是否含截距
  const rhoIdx = spec === 'n' ? 0 : 1;
  const rho = fit.coefficients[rhoIdx];
  const se = fit.stdErrors[rhoIdx];
  return { statistic: se > 0 ? rho / se : NaN, nobs: effective };
}

/**
 * ADF 单位根检验主入口。
 * @param y 输入序列（价格或收益均可，语义由调用方决定）
 * @param opts.spec 回归设定，默认 'c'
 * @param opts.maxLag 滞后上限（默认 Schwert 规则）
 * @param opts.criterion 'aic'（默认）或 'bic'
 */
export function adfTest(
  y: number[],
  opts: { spec?: AdfSpec; maxLag?: number; criterion?: 'aic' | 'bic' } = {},
): AdfResult {
  const spec = opts.spec ?? 'c';
  const criterion = opts.criterion ?? 'aic';
  if (y.length < 8) {
    throw new Error(`ADF 检验需要至少 8 个观测，当前 ${y.length}`);
  }
  const n = y.length;
  const maxLag = Math.max(0, Math.min(opts.maxLag ?? schwertMaxLag(n), schwertMaxLag(n)));

  // 逐阶评分选阶：k > 0 时允许用更短的公共样本对比，这里采用「各自满样本」口径
  // （与 statsmodels 默认一致：不同 lag 的 nobs 不同，AIC 直接可比）
  const scores: { lag: number; score: number }[] = [];
  let bestLag = 0;
  let bestScore = Infinity;
  for (let k = 0; k <= maxLag; k++) {
    const nobs = n - k - 1;
    if (nobs < 6) break;
    const fit = adfRegression(y, spec, k);
    if (!Number.isFinite(fit.statistic)) continue;
    // 重算 SSR 以取信息准则：直接从残差口径再跑一次太浪费，用 statistic 无法反推，
    // 这里复用 olsWithStats 的方式重算（nobs 小、开销可忽略）
    const ssr = adfSsr(y, spec, k);
    const kParams = k + (spec === 'n' ? 1 : 2) + 1; // 滞后项 + 常数(趋势) + ρ
    const aic = nobs * Math.log(ssr / nobs) + 2 * kParams;
    const bic = nobs * Math.log(ssr / nobs) + Math.log(nobs) * kParams;
    const score = criterion === 'bic' ? bic : aic;
    scores.push({ lag: k, score });
    if (score < bestScore) {
      bestScore = score;
      bestLag = k;
    }
  }

  const final = adfRegression(y, spec, bestLag);
  const cv = ASYMPTOTIC_CV[spec];
  const pValue = Number.isFinite(final.statistic) ? pValueFromAnchors(final.statistic, cv) : NaN;

  return {
    statistic: final.statistic,
    lag: bestLag,
    nobs: final.nobs,
    spec,
    criticalValues: { '1%': cv[0], '5%': cv[1], '10%': cv[2] },
    pValue,
    rejectAt5: Number.isFinite(final.statistic) && final.statistic < cv[1],
    lagSelection: { criterion, maxLag, scores },
  };
}

/** 固定滞后阶的 SSR（选阶评分用） */
function adfSsr(y: number[], spec: AdfSpec, lag: number): number {
  const n = y.length;
  const effective = n - lag - 1;
  const regressors: number[][] = [];
  const level: number[] = new Array<number>(effective);
  for (let i = 0; i < effective; i++) level[i] = y[lag + i];
  regressors.push(level);
  if (spec === 'ct') {
    const trend: number[] = new Array<number>(effective);
    for (let i = 0; i < effective; i++) trend[i] = i;
    regressors.push(trend);
  }
  const diff: number[] = new Array<number>(n - 1);
  for (let i = 0; i < n - 1; i++) diff[i] = y[i + 1] - y[i];
  for (let l = 1; l <= lag; l++) {
    const col: number[] = new Array<number>(effective);
    for (let i = 0; i < effective; i++) col[i] = diff[lag + i - l];
    regressors.push(col);
  }
  const dy: number[] = new Array<number>(effective);
  for (let i = 0; i < effective; i++) dy[i] = diff[lag + i];
  const fit = olsWithStats(dy, regressors, spec !== 'n');
  let ssr = 0;
  for (const r of fit.residuals) ssr += r * r;
  return Math.max(ssr, 1e-300);
}
