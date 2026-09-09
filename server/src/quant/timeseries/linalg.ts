/**
 * 时间序列模块的小型线性代数工具。
 * ============================================================================
 * 只覆盖 2-8 维的小矩阵（ADF / AR 回归的设计矩阵都很窄），用高斯消元 +
 * 部分主元求解与求逆，不引入第三方依赖。回归同时输出系数标准误，
 * 这是 factorStats.olsRegression（只给系数与残差）覆盖不了的口径。
 *
 * 全部纯函数、确定性、无副作用。
 */

/** 带统计量的 OLS 回归结果 */
export interface OlsWithStats {
  /** 回归系数，第一个是截距（若 includeIntercept 为 true） */
  coefficients: number[];
  /** 系数标准误，与 coefficients 一一对应；求逆失败时为 NaN */
  stdErrors: number[];
  residuals: number[];
  r2: number;
  /** X'X 是否可逆（近奇异时 stdErrors 为 NaN，系数仍可用） */
  fullRank: boolean;
}

/** 高斯消元 + 部分主元求解 A·x = b；A 奇异时返回 null */
export function solveLinearSystem(A: number[][], b: number[]): number[] | null {
  const n = A.length;
  if (n === 0 || b.length !== n) return null;
  // 复制为增广矩阵，避免改写入参
  const M: number[][] = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    // 部分主元：选当前列绝对值最大的行
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (Math.abs(M[pivot][col]) < 1e-12) return null;
    if (pivot !== col) {
      const tmp = M[pivot];
      M[pivot] = M[col];
      M[col] = tmp;
    }
    const d = M[col][col];
    for (let c = col; c <= n; c++) M[col][c] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row) => row[n]);
}

/** 方阵求逆（高斯-约当）；奇异时返回 null */
export function invertMatrix(A: number[][]): number[][] | null {
  const n = A.length;
  if (n === 0) return null;
  const M: number[][] = A.map((row) => [...row, ...new Array<number>(n).fill(0)]);
  for (let i = 0; i < n; i++) M[i][n + i] = 1;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (Math.abs(M[pivot][col]) < 1e-12) return null;
    if (pivot !== col) {
      const tmp = M[pivot];
      M[pivot] = M[col];
      M[col] = tmp;
    }
    const d = M[col][col];
    for (let c = 0; c < 2 * n; c++) M[col][c] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      if (f === 0) continue;
      for (let c = 0; c < 2 * n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row) => row.slice(n));
}

/**
 * OLS 回归：y = b0 + B·X + ε（includeIntercept=false 时无常数项）。
 * 标准误用经典公式 se = sqrt(σ̂² · (X'X)^{-1}) 对角元，σ̂² = SSR / (n − p)。
 */
export function olsWithStats(
  y: number[],
  predictors: number[][],
  includeIntercept = true,
): OlsWithStats {
  const n = y.length;
  const k = predictors.length;
  const p = k + (includeIntercept ? 1 : 0);
  const empty: OlsWithStats = {
    coefficients: new Array<number>(p).fill(0),
    stdErrors: new Array<number>(p).fill(NaN),
    residuals: [],
    r2: 0,
    fullRank: false,
  };
  if (n === 0 || n < p) return empty;

  const X: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row = includeIntercept ? [1] : [];
    for (let j = 0; j < k; j++) row.push(predictors[j][i] ?? 0);
    X.push(row);
  }

  const XtX: number[][] = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  const Xty: number[] = new Array<number>(p).fill(0);
  for (let i = 0; i < n; i++) {
    for (let r = 0; r < p; r++) {
      Xty[r] += X[i][r] * y[i];
      for (let c = r; c < p; c++) XtX[r][c] += X[i][r] * X[i][c];
    }
  }
  // 对称补全
  for (let r = 0; r < p; r++) for (let c = 0; c < r; c++) XtX[r][c] = XtX[c][r];

  const XtXinv = invertMatrix(XtX);
  if (!XtXinv) return empty;

  const beta: number[] = new Array<number>(p).fill(0);
  for (let r = 0; r < p; r++) {
    let s = 0;
    for (let c = 0; c < p; c++) s += XtXinv[r][c] * Xty[c];
    beta[r] = s;
  }

  const residuals: number[] = new Array<number>(n);
  let ssr = 0;
  let tss = 0;
  const yBar = y.reduce((a, b) => a + b, 0) / n;
  for (let i = 0; i < n; i++) {
    let fit = 0;
    for (let j = 0; j < p; j++) fit += beta[j] * X[i][j];
    residuals[i] = y[i] - fit;
    ssr += residuals[i] * residuals[i];
    tss += (y[i] - yBar) * (y[i] - yBar);
  }

  const dof = Math.max(n - p, 1);
  const sigma2 = ssr / dof;
  const stdErrors = beta.map((_, r) =>
    XtXinv[r][r] >= 0 ? Math.sqrt(sigma2 * XtXinv[r][r]) : NaN,
  );

  return {
    coefficients: beta,
    stdErrors,
    residuals,
    r2: tss > 0 ? 1 - ssr / tss : 0,
    fullRank: true,
  };
}

/**
 * 确定性高斯噪声发生器（mulberry32 PRNG + Box-Muller），供统计模拟测试用。
 * 同一 seed 永远产出同一序列，测试可复现。
 */
export function gaussianStream(seed: number): () => number {
  let a = seed >>> 0;
  const next = (): number => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let cached: number | null = null;
  return (): number => {
    if (cached !== null) {
      const v = cached;
      cached = null;
      return v;
    }
    // 避开 0 与 1，防 log(0)
    let u1 = next();
    let u2 = next();
    u1 = Math.max(u1, 1e-12);
    u2 = Math.max(u2, 1e-12);
    const r = Math.sqrt(-2 * Math.log(u1));
    const theta = 2 * Math.PI * u2;
    cached = r * Math.sin(theta);
    return r * Math.cos(theta);
  };
}
