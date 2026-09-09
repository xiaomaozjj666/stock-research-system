/**
 * 条件波动率建模：GARCH(1,1) 与 EGARCH(1,1)，Gaussian QML。
 * ============================================================================
 * GARCH(1,1)：
 *   ε_t = y_t − μ（常数均值）
 *   σ²_t = ω + α·ε²_{t-1} + β·σ²_{t-1}
 * 约束 ω>0、α≥0、β≥0、α+β<1；α+β（持续性）越接近 1，波动冲击衰减越慢。
 *
 * EGARCH(1,1)（对数方差方程，天然保证 σ²>0）：
 *   log σ²_t = ω + α·(|z_{t-1}| − E|z|) + γ·z_{t-1} + β·log σ²_{t-1}，z = ε/σ
 *   E|z| = √(2/π)（标准正态）。γ < 0 表示「坏消息」抬升波动的幅度大于
 *   同幅度的「好消息」——杠杆效应；这是 GARCH 对称结构捕捉不到的。
 *
 * 估计：高斯准极大似然（QML），Nelder-Mead 单纯形法最大化对数似然。
 * GARCH(1,1)/EGARCH(1,1) 各只有 3-4 个参数，直接优化无需梯度，
 * 不引入第三方数值库；非负与平稳性约束通过罚函数处理。
 *
 * 输出含条件方差全序列与一步前瞻预测（σ²_{T+1}）及年化波动率（√252）。
 * 全部纯函数、确定性、无第三方依赖。
 */

import { gaussianStream } from './linalg.js';

export type GarchModel = 'garch' | 'egarch';

export interface GarchFit {
  model: GarchModel;
  /** 常数均值 */
  mu: number;
  /** GARCH: ω/α/β；EGARCH: ω/α/γ/β（γ 为杠杆效应项） */
  omega: number;
  alpha: number;
  beta: number;
  gamma?: number;
  /** 持续性：GARCH 为 α+β，EGARCH 为 β（冲击衰减速度的对应口径） */
  persistence: number;
  logLik: number;
  aic: number;
  bic: number;
  /** 条件方差序列（与输入等长，首值用样本方差初始化） */
  condVariance: number[];
  /** 一步前瞻预测：σ²_{T+1} 及其年化波动率 */
  forecast: { sigma2: number; sigmaDaily: number; sigmaAnnualized: number };
  /** 是否收敛（单纯形步长低于容差） */
  converged: boolean;
  /** EGARCH 的杠杆效应方向提示：γ 显著为负时 true */
  leverageEffect: boolean;
}

/** 单位正态密度与对数似然常量 */
const LOG_SQRT_2PI = 0.5 * Math.log(2 * Math.PI);
const E_ABS_Z = Math.sqrt(2 / Math.PI);

/**
 * GARCH(1,1) 条件方差递推。方差初始化为全样本方差（无偏口径）。
 * 返回逐期条件方差；参数违约时返回全 NaN（罚函数路径会淘汰该点）。
 */
function garchVariances(eps: number[], omega: number, alpha: number, beta: number): number[] {
  const n = eps.length;
  const out = new Array<number>(n);
  let s2 = 0;
  const mean = eps.reduce((a, b) => a + b, 0) / n;
  for (const e of eps) s2 += (e - mean) * (e - mean);
  out[0] = Math.max(s2 / Math.max(n - 1, 1), 1e-12);
  for (let t = 1; t < n; t++) {
    const v = omega + alpha * eps[t - 1] * eps[t - 1] + beta * out[t - 1];
    if (!Number.isFinite(v) || v <= 0) {
      out[t] = NaN;
      // 后续全部置 NaN，让外层罚函数淘汰
      for (let s = t + 1; s < n; s++) out[s] = NaN;
      break;
    }
    out[t] = v;
  }
  return out;
}

/** EGARCH(1,1) 对数方差递推，初始化 log σ²₀ = log(样本方差) */
function egarchLogVariances(
  eps: number[],
  omega: number,
  alpha: number,
  gamma: number,
  beta: number,
): { logVar: number[]; z: number[] } {
  const n = eps.length;
  let s2 = 0;
  const mean = eps.reduce((a, b) => a + b, 0) / n;
  for (const e of eps) s2 += (e - mean) * (e - mean);
  const v0 = Math.max(s2 / Math.max(n - 1, 1), 1e-12);
  const logVar = new Array<number>(n);
  const z = new Array<number>(n);
  logVar[0] = Math.log(v0);
  z[0] = eps[0] / Math.sqrt(v0);
  for (let t = 1; t < n; t++) {
    const lv =
      omega + alpha * (Math.abs(z[t - 1]) - E_ABS_Z) + gamma * z[t - 1] + beta * logVar[t - 1];
    if (!Number.isFinite(lv) || lv > 50 || lv < -50) {
      // exp 溢出保护：直接判罚
      for (let s = t; s < n; s++) {
        logVar[s] = NaN;
        z[s] = NaN;
      }
      break;
    }
    logVar[t] = lv;
    const v = Math.exp(lv);
    z[t] = eps[t] / Math.sqrt(v);
  }
  return { logVar, z };
}

/** 高斯 QML 对数似然：Σ −½[log(2π) + log σ²_t + ε²_t/σ²_t]；违约返回 −Infinity */
function gaussianLogLik(eps: number[], variances: number[]): number {
  let ll = 0;
  for (let t = 1; t < eps.length; t++) {
    const v = variances[t];
    if (!Number.isFinite(v) || v <= 0) return -Infinity;
    ll -= 0.5 * (LOG_SQRT_2PI + Math.log(v) + (eps[t] * eps[t]) / v);
  }
  return ll;
}

// ============================================================
// Nelder-Mead 单纯形（2-4 维够用，标准反射/扩张/收缩/缩并）
// ============================================================

interface NmResult {
  x: number[];
  f: number;
  converged: boolean;
}

function nelderMead(
  objective: (x: number[]) => number,
  initial: number[],
  opts: { maxIter?: number; tol?: number } = {},
): NmResult {
  const n = initial.length;
  const maxIter = opts.maxIter ?? 1500;
  const tol = opts.tol ?? 1e-9;

  // 初始单纯形：每维加 5%（0 时加 0.0125）
  const simplex: number[][] = [initial.slice()];
  for (let j = 0; j < n; j++) {
    const p = initial.slice();
    p[j] += p[j] !== 0 ? 0.05 * Math.abs(p[j]) : 0.0125;
    simplex.push(p);
  }
  let values = simplex.map(objective);

  for (let iter = 0; iter < maxIter; iter++) {
    // 按 f 升序
    const idx = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
    const sorted = idx.map(([, i]) => simplex[i]);
    values = idx.map(([v]) => v);

    // 收敛判定：最好与最差的目标差 + 单纯形直径
    const spread = Math.abs(values[n] - values[0]);
    let diameter = 0;
    for (let j = 1; j <= n; j++) {
      for (let d = 0; d < n; d++)
        diameter = Math.max(diameter, Math.abs(sorted[j][d] - sorted[0][d]));
    }
    if (spread < tol || diameter < 1e-6) {
      return { x: sorted[0], f: values[0], converged: true };
    }

    // 质心（去掉最差点）
    const centroid = new Array<number>(n).fill(0);
    for (let j = 0; j < n; j++) {
      for (let d = 0; d < n; d++) centroid[d] += sorted[j][d] / n;
    }
    const reflect = centroid.map((c, d) => c + (c - sorted[n][d]));
    const fR = objective(reflect);
    if (fR < values[0]) {
      const expand = centroid.map((c, d) => c + 2 * (c - sorted[n][d]));
      const fE = objective(expand);
      if (fE < fR) {
        simplex[n] = expand;
        values[n] = fE;
      } else {
        simplex[n] = reflect;
        values[n] = fR;
      }
      continue;
    }
    if (fR < values[n - 1]) {
      simplex[n] = reflect;
      values[n] = fR;
      continue;
    }
    // 收缩
    const contracted = centroid.map((c, d) => c + 0.5 * (sorted[n][d] - c));
    const fC = objective(contracted);
    if (fC < values[n]) {
      simplex[n] = contracted;
      values[n] = fC;
      continue;
    }
    // 缩并向最优点
    for (let j = 1; j <= n; j++) {
      for (let d = 0; d < n; d++) sorted[j][d] = sorted[0][d] + 0.5 * (sorted[j][d] - sorted[0][d]);
      simplex[j] = sorted[j];
      values[j] = objective(sorted[j]);
    }
  }
  const idxBest = values.indexOf(Math.min(...values));
  return { x: simplex[idxBest], f: values[idxBest], converged: false };
}

/** 原始空间约束罚：ω>0、α≥0、β≥0、α+β<1（违反量按偏离比例放大） */
function garchPenalty(omega: number, alpha: number, beta: number): number {
  let p = 0;
  if (omega <= 0) p += 1e6 * (1 - omega);
  if (alpha < 0) p += 1e6 * -alpha;
  if (beta < 0) p += 1e6 * -beta;
  if (alpha + beta >= 0.999) p += 1e6 * (alpha + beta - 0.998);
  return p;
}

/**
 * 拟合 GARCH(1,1)。
 * @param returns 收益序列（小数口径，日频）
 */
export function fitGarch(returns: number[], opts: { maxIter?: number } = {}): GarchFit {
  if (returns.length < 60) {
    throw new Error(`GARCH 拟合需要至少 60 个观测，当前 ${returns.length}`);
  }
  const mu = returns.reduce((a, b) => a + b, 0) / returns.length;
  const eps = returns.map((r) => r - mu);
  const s2 = eps.reduce((a, e) => a + e * e, 0) / Math.max(eps.length - 1, 1);

  const negLogLik = (x: number[]): number => {
    const [omega, alpha, beta] = x;
    const vars = garchVariances(eps, omega, alpha, beta);
    let ll = gaussianLogLik(eps, vars);
    if (!Number.isFinite(ll)) ll = -1e12;
    return -ll + garchPenalty(omega, alpha, beta);
  };

  // 多起点 + 两阶段单纯形：GARCH 似然面在持续性接近 1 时相当平缓，
  // 单起点容易停在半山腰；从几组经验 α/β 区间出发各收敛一次取最优
  const starts: [number, number][] = [
    [0.08, 0.88],
    [0.05, 0.9],
    [0.12, 0.8],
    [0.03, 0.95],
  ];
  let best: { x: number[]; f: number; converged: boolean } | null = null;
  for (const [a0, b0] of starts) {
    const omega0 = Math.max(s2 * (1 - a0 - b0), 1e-12);
    const r1 = nelderMead(negLogLik, [omega0, a0, b0], { maxIter: 500 });
    // 第二阶段：以第一阶段终点重新展开单纯形，摆脱小步长下的假收敛
    const r2 = nelderMead(negLogLik, r1.x, { maxIter: opts.maxIter ?? 2000 });
    if (!best || r2.f < best.f) best = r2;
  }
  const nm = best!;
  const omega = nm.x[0];
  const alpha = nm.x[1];
  const beta = nm.x[2];
  const vars = garchVariances(eps, omega, alpha, beta);
  const ll = -nm.f;
  const k = 4; // μ, ω, α, β
  const n = returns.length;
  const sigma2Next =
    omega + alpha * eps[eps.length - 1] * eps[eps.length - 1] + beta * vars[vars.length - 1];
  const sigmaDaily = Math.sqrt(Math.max(sigma2Next, 0));

  return {
    model: 'garch',
    mu,
    omega,
    alpha,
    beta,
    persistence: alpha + beta,
    logLik: ll,
    aic: -2 * ll + 2 * k,
    bic: -2 * ll + Math.log(n) * k,
    condVariance: vars,
    forecast: {
      sigma2: sigma2Next,
      sigmaDaily,
      sigmaAnnualized: sigmaDaily * Math.sqrt(252),
    },
    converged: nm.converged,
    leverageEffect: false,
  };
}

/**
 * 拟合 EGARCH(1,1)（带杠杆效应项 γ）。
 */
export function fitEgarch(returns: number[], opts: { maxIter?: number } = {}): GarchFit {
  if (returns.length < 60) {
    throw new Error(`EGARCH 拟合需要至少 60 个观测，当前 ${returns.length}`);
  }
  const mu = returns.reduce((a, b) => a + b, 0) / returns.length;
  const eps = returns.map((r) => r - mu);
  const s2 = eps.reduce((a, e) => a + e * e, 0) / Math.max(eps.length - 1, 1);
  const logS2 = Math.log(Math.max(s2, 1e-12));

  const negLogLik = (theta: number[]): number => {
    const [omega, alpha, gamma, beta] = theta;
    const { logVar } = egarchLogVariances(eps, omega, alpha, gamma, beta);
    let ll = 0;
    for (let t = 1; t < eps.length; t++) {
      const lv = logVar[t];
      if (!Number.isFinite(lv)) {
        ll = -1e12;
        break;
      }
      ll -= 0.5 * (LOG_SQRT_2PI + lv + (eps[t] * eps[t]) / Math.exp(lv));
    }
    return -ll;
  };

  // 多起点 + 两阶段单纯形（同 GARCH 思路；γ 覆盖从无杠杆到明显负杠杆）
  const starts: [number, number, number][] = [
    [0.1, -0.05, 0.95],
    [0.15, -0.1, 0.9],
    [0.05, 0.0, 0.97],
    [0.2, -0.15, 0.85],
  ];
  let best: { x: number[]; f: number; converged: boolean } | null = null;
  for (const [a0, g0, b0] of starts) {
    const x0 = [logS2 * (1 - b0), a0, g0, b0];
    const r1 = nelderMead(negLogLik, x0, { maxIter: 500 });
    const r2 = nelderMead(negLogLik, r1.x, { maxIter: opts.maxIter ?? 2000 });
    if (!best || r2.f < best.f) best = r2;
  }
  const nm = best!;
  const [omega, alpha, gamma, beta] = nm.x;
  const { logVar, z } = egarchLogVariances(eps, omega, alpha, gamma, beta);
  const ll = -nm.f;
  const k = 5; // μ, ω, α, γ, β
  const n = returns.length;
  const lastT = eps.length - 1;
  // 一步前瞻：z_T 用实现值，|z| 用其期望近似之后递推
  const lvNext =
    omega + alpha * (Math.abs(z[lastT]) - E_ABS_Z) + gamma * z[lastT] + beta * logVar[lastT];
  const sigma2Next = Number.isFinite(lvNext) ? Math.exp(lvNext) : s2;
  const sigmaDaily = Math.sqrt(Math.max(sigma2Next, 0));

  return {
    model: 'egarch',
    mu,
    omega,
    alpha,
    gamma,
    beta,
    persistence: beta,
    logLik: ll,
    aic: -2 * ll + 2 * k,
    bic: -2 * ll + Math.log(n) * k,
    condVariance: logVar.map((lv) => (Number.isFinite(lv) ? Math.exp(lv) : NaN)),
    forecast: {
      sigma2: sigma2Next,
      sigmaDaily,
      sigmaAnnualized: sigmaDaily * Math.sqrt(252),
    },
    converged: nm.converged,
    // γ 相对标准误没有解析式（QML 数值估计），以 γ < −0.02 为方向性提示
    leverageEffect: gamma < -0.02,
  };
}

/**
 * 便捷入口：同一序列同时拟合 GARCH(1,1) 与 EGARCH(1,1)，按 BIC 给出偏好。
 * 对比口径：AIC/BIC 越小越好；EGARCH 的 γ<0 且 BIC 更低 → 波动存在不对称反应。
 */
export function fitVolatilityModels(
  returns: number[],
  opts: { maxIter?: number } = {},
): { garch: GarchFit; egarch: GarchFit; prefer: 'garch' | 'egarch' } {
  const g = fitGarch(returns, opts);
  const e = fitEgarch(returns, opts);
  return { garch: g, egarch: e, prefer: e.bic < g.bic ? 'egarch' : 'garch' };
}

/**
 * 用已知参数模拟 GARCH(1,1) 路径（确定性 PRNG），供测试与教学复现。
 */
export function simulateGarch(
  n: number,
  params: { mu: number; omega: number; alpha: number; beta: number },
  seed = 42,
): { returns: number[]; condVariance: number[] } {
  const normal = gaussianStream(seed);
  const { mu, omega, alpha, beta } = params;
  const v0 = omega / Math.max(1 - alpha - beta, 1e-6);
  let v = v0;
  const returns: number[] = [];
  const condVariance: number[] = [];
  for (let t = 0; t < n; t++) {
    condVariance.push(v);
    const e = normal();
    returns.push(mu + Math.sqrt(v) * e);
    v = omega + alpha * (Math.sqrt(v) * e) ** 2 + beta * v;
  }
  return { returns, condVariance };
}
