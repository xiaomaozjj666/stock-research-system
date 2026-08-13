/**
 * CSCV / PBO —— 组合对称交叉验证 + 回测过拟合概率
 * ============================================================================
 * 目的：量化「从一组候选策略里挑最优」这一选择过程本身引入的过拟合风险，
 * 回答：当前 IS（样本内）选出的最佳策略，其 OOS（样本外）表现有多大几率掉到中位数之下？
 *
 * 方法（CSCV，Combinatorial Symmetric Cross-Validation，De Prado et al. 2017）：
 *  1. 输入 M 个候选策略在 T 个交易日的收益矩阵（行 = 日，列 = 策略）。
 *  2. 把 T 天切成 S 个连续时间块（S 取偶数，建议 8-16）。
 *  3. 枚举全部 C(S, S/2) 个「取一半块做样本内（IS）、剩下一半做样本外（OOS）」的组合。
 *  4. 对每个组合：在 IS 上按绩效指标（默认 Sharpe）选出最优策略，计算该策略在 OOS 上
 *     的相对排名 ω = 击败其他策略的比例 ∈ [0,1]。
 *  5. PBO = IS 最优策略在 OOS 上落于中位数之下（ω < 0.5）的组合占比。
 *
 * 解读：
 *  - PBO 越低越好。PBO≈0.5 说明选优近乎靠运气（与随机选择无异）；
 *    PBO≈0 说明 IS 最优在 OOS 稳定占优（选择有效）；
 *    PBO 偏高说明 IS 最优在 OOS 频繁崩盘（过拟合严重）。
 *
 * 参考：Bailey, Borwein, López de Prado, Zhu (2017),
 *       "The Probability of Backtest Overfitting", Journal of Computational Finance 20(4)。
 *
 * 设计：纯函数、确定性（组合枚举，无随机源），便于单测。
 */

/** CSCV 配置 */
export interface CscvOptions {
  /**
   * 时间分块数 S（必须为偶数，建议 8-16），默认 8。
   * 数据不足时自动下调到能容纳的最大偶数（下限 4）。
   */
  numBlocks?: number;
  /** 策略绩效指标，默认 'sharpe'（收益均值 / 样本标准差） */
  performance?: 'sharpe' | 'meanReturn';
}

/** CSCV 计算结果 */
export interface CscvResult {
  /** 回测过拟合概率 PBO ∈ [0,1]（越低越好） */
  pbo: number;
  /** 组合数 C(S, S/2) */
  nCombinations: number;
  /** 实际使用的时间分块数 S */
  numBlocks: number;
  /** 候选策略数（收益矩阵列数） */
  numStrategies: number;
  /** 各组合的 IS 最优策略在 OOS 的相对排名 ω（诊断用，长度 = nCombinations） */
  relativeRanks: number[];
  /**
   * 各策略跨所有组合的平均 IS / OOS 绩效（诊断用）。
   * 形状 2 × M：is[s] = 策略 s 在所有组合上 IS 绩效的均值，oos[s] 同理。
   * 指标由 options.performance 决定（默认 Sharpe；'meanReturn' 时为日收益均值）。
   */
  sharpeMatrix: {
    is: number[];
    oos: number[];
  };
}

/** 从 0..n-1 中取 k 个的所有组合（字典序，纯函数） */
function combinations(n: number, k: number): number[][] {
  const out: number[][] = [];
  const idx: number[] = [];
  const rec = (start: number): void => {
    if (idx.length === k) {
      out.push([...idx]);
      return;
    }
    for (let i = start; i < n; i++) {
      idx.push(i);
      rec(i + 1);
      idx.pop();
    }
  };
  rec(0);
  return out;
}

/** 把 0..T-1 切成 S 个尽量等长的连续时间块（多出的余数给前几个块） */
function splitBlocks(T: number, S: number): number[][] {
  const blocks: number[][] = [];
  const base = Math.floor(T / S);
  const extra = T % S;
  let start = 0;
  for (let b = 0; b < S; b++) {
    const len = base + (b < extra ? 1 : 0);
    blocks.push(Array.from({ length: len }, (_, i) => start + i));
    start += len;
  }
  return blocks;
}

/** 给定行集合下策略 s 的绩效指标（Sharpe 或日收益均值）；行数不足 2 时退化为 0 */
function performanceOf(
  returns: number[][],
  rows: number[],
  s: number,
  metric: NonNullable<CscvOptions['performance']>,
): number {
  if (rows.length < 2) return 0;
  let mean = 0;
  for (const r of rows) mean += returns[r][s];
  mean /= rows.length;
  if (metric === 'meanReturn') return mean;
  // sharpe：样本标准差（n-1 自由度）
  let variance = 0;
  for (const r of rows) {
    const d = returns[r][s] - mean;
    variance += d * d;
  }
  variance /= rows.length - 1;
  if (variance <= 0) return 0;
  return mean / Math.sqrt(variance);
}

/**
 * 计算组合对称交叉验证（CSCV）的回测过拟合概率（PBO）。
 *
 * @param returns 候选策略日收益矩阵：returns[t][s] = 策略 s 在第 t 天的收益
 *                （行 = 日，列 = 策略；要求行数 T ≥ 4、列数 M ≥ 2，且为矩形）。
 * @param options CSCV 配置（分块数 / 绩效指标）
 * @returns 见 CscvResult
 */
export function computePbo(returns: number[][], options: CscvOptions = {}): CscvResult {
  const T = returns.length;
  const M = T > 0 ? returns[0].length : 0;
  if (T < 4 || M < 2) {
    throw new Error(`computePbo：收益矩阵过小（${T} 行 × ${M} 列），需要至少 4 个时点与 2 个策略`);
  }
  // 要求矩形矩阵，避免逐行长度不一致导致静默错位
  for (const row of returns) {
    if (row.length !== M) {
      throw new Error(
        `computePbo：收益矩阵不是矩形（第 ${returns.indexOf(row)} 行列数为 ${row.length}，期望 ${M}）`,
      );
    }
  }

  // 分块数：用户指定或默认 8；保证为偶数且落在 [4, T] 内
  let S = options.numBlocks ?? 8;
  if (S % 2 !== 0) S -= 1;
  S = Math.max(4, Math.min(S, T % 2 === 0 ? T : T - 1));
  if (S < 4) {
    throw new Error(`computePbo：时点数 ${T} 过少，无法切出至少 4 块`);
  }

  const metric = options.performance ?? 'sharpe';
  const blocks = splitBlocks(T, S);
  const combos = combinations(S, S / 2);
  const nC = combos.length;

  let pboHits = 0;
  const relativeRanks: number[] = [];
  const isSum = new Array<number>(M).fill(0);
  const oosSum = new Array<number>(M).fill(0);

  for (const isBlocks of combos) {
    const isSet = new Set(isBlocks);
    const isRows: number[] = [];
    const oosRows: number[] = [];
    for (let b = 0; b < S; b++) {
      (isSet.has(b) ? isRows : oosRows).push(...blocks[b]);
    }

    // 每个策略的 IS / OOS 绩效
    const isP = new Array<number>(M);
    const oosP = new Array<number>(M);
    for (let s = 0; s < M; s++) {
      isP[s] = performanceOf(returns, isRows, s, metric);
      oosP[s] = performanceOf(returns, oosRows, s, metric);
    }

    // IS 最优策略（并列取最小下标，确定性）
    let best = 0;
    for (let s = 1; s < M; s++) {
      if (isP[s] > isP[best]) best = s;
    }

    // OOS 相对排名：该策略击败其他策略的比例 ω ∈ [0,1]；ω < 0.5 = 落于中位数之下
    let beats = 0;
    for (let s = 0; s < M; s++) {
      if (s !== best && oosP[s] < oosP[best]) beats++;
    }
    const omega = beats / (M - 1);
    relativeRanks.push(omega);
    if (omega < 0.5) pboHits++;

    for (let s = 0; s < M; s++) {
      isSum[s] += isP[s];
      oosSum[s] += oosP[s];
    }
  }

  return {
    pbo: pboHits / nC,
    nCombinations: nC,
    numBlocks: S,
    numStrategies: M,
    relativeRanks,
    sharpeMatrix: {
      is: isSum.map((v) => v / nC),
      oos: oosSum.map((v) => v / nC),
    },
  };
}
