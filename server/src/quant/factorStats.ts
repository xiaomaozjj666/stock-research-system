/**
 * 统计基础（Statistical Primitives）
 * --------------------------------------------------------------------------
 * 因子显著性检验与中性化所需的数值工具。全部纯函数、无副作用、可独立单测，
 * 不引入任何第三方依赖（Node 环境无 scipy/statsmodels 可用）。
 *
 *   1. erf / normalCdf        —— 误差函数与标准正态 CDF（A&S 7.1.26，|ε| < 1.5e-7）
 *   2. logGamma / incompleteBeta —— Lanczos 近似 + Lentz 连分数（Numerical Recipes 算法）
 *   3. studentTTwoSidedP      —— Student t 双侧 p 值，用于 IC 序列的显著性检验
 *   4. sampleSkewness / sampleExcessKurtosis —— scipy.stats bias=False 口径
 *   5. olsRegression          —— 多元 OLS（正规方程 + 部分选主元高斯消元），用于中性化取残差
 *   6. winsorizeMad           —— 中位数绝对偏差去极值（聚宽 winsorize_med 同口径）
 *
 * 之所以需要这些：仅有 IC 均值与 IR 无法判断因子是否「统计显著」。样本量小时
 * IR 极易被噪声撑高，必须用 t 检验把「真实 alpha」与「运气」区分开。
 */

/** Abramowitz & Stegun 7.1.26 的五阶有理逼近系数 */
const ERF_P = 0.3275911;
const ERF_A1 = 0.254829592;
const ERF_A2 = -0.284496736;
const ERF_A3 = 1.421413741;
const ERF_A4 = -1.453152027;
const ERF_A5 = 1.061405429;

/** 误差函数 erf(x)：最大绝对误差 < 1.5e-7，足够金融统计使用 */
export function erf(x: number): number {
  if (Number.isNaN(x)) return NaN;
  if (x === Infinity) return 1;
  if (x === -Infinity) return -1;
  // x=0 显式返回：A&S 逼近在原点残留约 1e-9 的误差，会让 Φ(0) 偏离 0.5
  if (x === 0) return 0;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + ERF_P * ax);
  const poly = ((((ERF_A5 * t + ERF_A4) * t + ERF_A3) * t + ERF_A2) * t + ERF_A1) * t;
  return sign * (1 - poly * Math.exp(-ax * ax));
}

/** 标准正态分布累积分布函数 Φ(x) ∈ [0,1] */
export function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

/** Lanczos 近似（g=7, n=9）的 Γ 函数对数，相对误差 ~1e-15 */
export function logGamma(x: number): number {
  if (Number.isNaN(x)) return NaN;
  // 反射公式 Γ(x)Γ(1−x) = π / sin(πx)：把 x < 0.5 折回精度更高的区间
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const g = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  const z = x - 1;
  let a = g[0];
  const t = z + 7 + 0.5;
  for (let i = 1; i < g.length; i++) a += g[i] / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/** 连分数部分（Numerical Recipes betacf），供 incompleteBeta 内部使用 */
function betaContinuedFraction(x: number, a: number, b: number): number {
  const MAX_ITER = 300;
  const EPS = 3e-16;
  const TINY = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAX_ITER; m++) {
    const m2 = 2 * m;
    // 偶步
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    h *= d * c;
    // 奇步
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < EPS) break;
  }
  return h;
}

/**
 * 正则化不完全 Beta 函数 I_x(a, b) ∈ [0,1]。
 * 端点与非法输入按极限处理：x ≤ 0 → 0，x ≥ 1 → 1，参数非正 → NaN。
 */
export function incompleteBeta(x: number, a: number, b: number): number {
  if (!(a > 0) || !(b > 0) || Number.isNaN(x)) return NaN;
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const logBeta = logGamma(a) + logGamma(b) - logGamma(a + b);
  const front = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - logBeta);
  // 连分数在 x < (a+1)/(a+b+2) 时收敛快；否则用对称式 I_x(a,b) = 1 − I_{1−x}(b,a)
  return x < (a + 1) / (a + b + 2)
    ? (front * betaContinuedFraction(x, a, b)) / a
    : 1 - (front * betaContinuedFraction(1 - x, b, a)) / b;
}

/**
 * Student t 分布的双侧 p 值：P(|T| ≥ |t|)，自由度 df = n − 1。
 * 恒等式：p = I_{df/(df+t²)}(df/2, 1/2)。
 * t = 0 时返回 1（完全无法拒绝原假设）；df ≤ 0 或输入非有限时返回 1（保守：不宣称显著）。
 */
export function studentTTwoSidedP(t: number, df: number): number {
  if (!Number.isFinite(t) || !(df > 0)) return 1;
  if (t === 0) return 1;
  const p = incompleteBeta(df / (df + t * t), df / 2, 0.5);
  return Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : 1;
}

/**
 * 样本偏度（调整 Fisher-Pearson 标准化矩，与 scipy.stats.skew(bias=False) 一致）。
 * 完美对称分布为 0；样本数 < 3 或方差为 0 时返回 0。
 */
export function sampleSkewness(xs: number[]): number {
  const n = xs.length;
  if (n < 3) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  let m2 = 0;
  let m3 = 0;
  for (const v of xs) {
    const d = v - mean;
    m2 += d * d;
    m3 += d * d * d;
  }
  m2 /= n;
  m3 /= n;
  if (m2 <= 0) return 0;
  const g1 = m3 / Math.pow(m2, 1.5);
  return (Math.sqrt(n * (n - 1)) / (n - 2)) * g1;
}

/**
 * 样本超额峰度（与 scipy.stats.kurtosis(bias=False) 一致，正态分布 = 0）。
 * 样本数 < 4 或方差为 0 时返回 0。
 */
export function sampleExcessKurtosis(xs: number[]): number {
  const n = xs.length;
  if (n < 4) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  let m2 = 0;
  let m4 = 0;
  for (const v of xs) {
    const d = v - mean;
    m2 += d * d;
    m4 += d * d * d * d;
  }
  m2 /= n;
  m4 /= n;
  if (m2 <= 0) return 0;
  const g2 = m4 / (m2 * m2) - 3;
  return ((n - 1) / ((n - 2) * (n - 3))) * ((n + 1) * g2 + 6);
}

/** 中位数（偶数长度取两中间值均值，与 scipy/聚宽口径一致） */
function median(sortedAsc: number[]): number {
  const n = sortedAsc.length;
  if (n === 0) return NaN;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? sortedAsc[mid] : (sortedAsc[mid - 1] + sortedAsc[mid]) / 2;
}

/**
 * 中位数绝对偏差去极值（聚宽 winsorize_med 同口径）。
 * 边界 = median ± scale × 1.4826 × MAD；落在界外的值替换为边界值（inclusive）
 * 或 NaN（exclusive）。MAD = 0（半数以上取值相同）时不做处理。
 */
export function winsorizeMad(values: number[], scale = 3, inclusive = true): number[] {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length < 3) return [...values];
  const sorted = [...finite].sort((a, b) => a - b);
  const med = median(sorted);
  const deviations = sorted.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
  const mad = median(deviations);
  if (!(mad > 0)) return [...values];
  const span = scale * 1.4826 * mad;
  const lo = med - span;
  const hi = med + span;
  return values.map((v) => {
    if (!Number.isFinite(v)) return v;
    if (v < lo) return inclusive ? lo : NaN;
    if (v > hi) return inclusive ? hi : NaN;
    return v;
  });
}

export interface OlsResult {
  /** 回归系数 [截距, 自变量1, 自变量2, ...] */
  coefficients: number[];
  /** 残差 = y − ŷ，与 y 等长 */
  residuals: number[];
  /** 决定系数 R² ∈ [0,1]；完全退化时为 0 */
  r2: number;
  /** 设计矩阵是否列满秩；false 表示已退化（见下方回退说明） */
  fullRank: boolean;
}

/**
 * 多元 OLS 回归（含截距项）。用于因子中性化：把因子值对市值/行业哑变量回归，
 * 取残差作为「剔除风格与行业影响后」的纯净因子。
 *
 * 解法：正规方程 (XᵀX)β = Xᵀy + 部分选主元高斯消元。
 * 退化处理：XᵀX 奇异时（如某行业哑变量全零、样本数少于参数个数）不抛错，
 * 而是回退为「仅截距」模型（等价于对 y 去均值），并把 fullRank 置为 false，
 * 由调用方决定是否采用结果——中性化失败至少不应让整个分析崩掉。
 */
export function olsRegression(y: number[], predictors: number[][]): OlsResult {
  const n = y.length;
  const k = predictors.length;
  if (n === 0) {
    return {
      coefficients: [0, ...new Array<number>(k).fill(0)],
      residuals: [],
      r2: 0,
      fullRank: false,
    };
  }
  // 设计矩阵：第一列为截距
  const X: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row = [1];
    for (let j = 0; j < k; j++) row.push(predictors[j][i] ?? 0);
    X.push(row);
  }
  const p = k + 1;
  // 正规方程
  const A: number[][] = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  const b: number[] = new Array<number>(p).fill(0);
  for (let i = 0; i < n; i++) {
    for (let r = 0; r < p; r++) {
      b[r] += X[i][r] * y[i];
      for (let c = 0; c < p; c++) A[r][c] += X[i][r] * X[i][c];
    }
  }
  const beta = solveWithPartialPivoting(A, b);
  if (!beta) {
    // 退化：回退仅截距模型
    const mean = y.reduce((a, v) => a + v, 0) / n;
    return {
      coefficients: [mean, ...new Array<number>(k).fill(0)],
      residuals: y.map((v) => v - mean),
      r2: 0,
      fullRank: false,
    };
  }
  const fitted = X.map((row) => row.reduce((s, v, idx) => s + v * beta[idx], 0));
  const residuals = y.map((v, i) => v - fitted[i]);
  const yMean = y.reduce((a, v) => a + v, 0) / n;
  let ssTot = 0;
  let ssRes = 0;
  for (let i = 0; i < n; i++) {
    ssTot += (y[i] - yMean) ** 2;
    ssRes += residuals[i] ** 2;
  }
  return {
    coefficients: beta,
    residuals,
    r2: ssTot > 0 ? Math.max(0, Math.min(1, 1 - ssRes / ssTot)) : 0,
    fullRank: true,
  };
}

/** 部分选主元高斯消元；矩阵奇异时返回 null（由调用方回退） */
function solveWithPartialPivoting(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    // 主元相对量级过小 → 视为列不满秩（数值奇异）
    const scale = Math.abs(M[pivot][col]);
    if (!Number.isFinite(scale) || scale < 1e-12) return null;
    if (pivot !== col) {
      const tmp = M[pivot];
      M[pivot] = M[col];
      M[col] = tmp;
    }
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col] / M[col][col];
      if (factor === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
    }
  }
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const v = M[i][n] / M[i][i];
    if (!Number.isFinite(v)) return null;
    out[i] = v;
  }
  return out;
}
