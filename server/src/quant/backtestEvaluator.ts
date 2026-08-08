/**
 * 受控回测评估器（Backtest Evaluator）—— 学界标准增强版
 * ----------------------------------------------------------------------------
 * 回答核心问题：**LLM 信号（或任意增量改进）是否真的带来了 alpha？**
 *
 * 主流 Agent 系统落地 LLM 后必须有的纪律：不能只看实验组绝对收益好看就下结论，
 * 必须在同一数据/同一区间上与"无 LLM 的基线"做受控对比，并用统计显著性兜底，
 * 否则就是把数学内核让位给黑箱（项目核心约束之一）。
 *
 * 设计：纯函数 + 确定性（固定 seed），无外部依赖，便于单测。
 *
 * 学界标准对标（2025-2026 全网搜集）：
 * - 配对 t 检验 + Harvey-Liu-Zhu(2016) t≥3.0 阈值（因子动物园多重检验）
 * - Deflated Sharpe Ratio（Bailey-López de Prado 2014）：搜索次数 N + 非正态 + 样本长度校正
 * - 配对 Block Bootstrap CI（Politis-Romano 1994 stationary bootstrap）：替代 t 检验的非正态/自相关鲁棒版
 * - MinTRL（Minimum Track-Record Length）：达到 DSR≥0.95 所需最短回测年数
 * - 非正态诊断（偏度/峰度）：判断 t 检验假设是否成立
 * - 交易成本敏感性：A 股 0.4% round-trip 成本占比警示
 *
 * 输入：基线 BacktestResult（无 LLM）与实验 BacktestResult（带 LLM 信号/新闻叠加等）。
 * 输出：BacktestComparison，含逐指标 delta、alpha 归因、显著性结论、DSR、Bootstrap CI。
 */

import type { BacktestResult } from './types.js';

export interface MetricDelta {
  name: keyof Pick<BacktestResult,
    'totalReturn' | 'annualizedReturn' | 'sharpeRatio' | 'sortinoRatio' | 'maxDrawdown' | 'winRate' | 'profitFactor'>;
  baseline: number;
  experiment: number;
  /** experiment − baseline（maxDrawdown 为负=改善） */
  delta: number;
  /** 改善方向是否为「好」：收益/夏普/胜率/盈亏比↑好，回撤↓好 */
  improved: boolean;
}

/** 显著性分级（Harvey-Liu-Zhu 2016：t≥3.0 才算强显著） */
export type Significance =
  | 'significant_strong'     // |t| > 3.0，多重检验校正后仍显著
  | 'significant_marginal'   // 2.0 < |t| ≤ 3.0，单次检验显著但未做多重校正，存疑
  | 'not_significant'        // |t| ≤ 2.0
  | 'insufficient_sample';   // n < 30

export interface NonNormalityDiagnostic {
  skewness: number;
  excessKurtosis: number;
  /** true = 差值序列偏离正态，t 检验假设不成立，应参考 Bootstrap CI */
  nonNormal: boolean;
  warning: string;
}

export interface BootstrapResult {
  /** 95% 置信区间 [下限, 上限] */
  ci95: [number, number];
  /** 配对差均值 > 0 的 bootstrap p 值（单尾） */
  pValue: number;
  /** 重采样次数 */
  iterations: number;
  /** CI 是否跨 0（跨 0 = 不显著） */
  crossesZero: boolean;
}

export interface BacktestComparison {
  /** 逐指标对比 */
  metrics: MetricDelta[];
  /** 实验组相对基线的超额年化收益（百分点）—— alpha 的最直观度量 */
  alphaAnnualized: number;
  /** 配对日收益差 t 统计量 */
  tStatistic: number;
  /** 显著性结论（分级） */
  significance: Significance;
  /** 非正态诊断 */
  nonNormality?: NonNormalityDiagnostic;
  /** Deflated Sharpe Ratio ∈ [0,1]：考虑搜索次数/非正态/样本长度后，真实 SR>0 的概率 */
  deflatedSharpeRatio?: number;
  /** Probabilistic Sharpe Ratio ∈ [0,1]：未校正搜索次数的基准版 */
  probabilisticSharpeRatio?: number;
  /** MinTRL：达到 DSR≥0.95 所需最短回测年数 */
  minTrackRecordLength?: number;
  /** 配对 Block Bootstrap 置信区间 */
  bootstrap?: BootstrapResult;
  /** 综合判定：实验组是否优于基线 */
  verdict: 'experiment_wins' | 'baseline_wins' | 'tie' | 'inconclusive';
  /** 人类可读结论 */
  summary: string;
  /** 注意事项（数据质量/样本量/潜在过拟合/非正态/成本） */
  caveats: string[];
}

/** 从权益曲线反推日收益率序列 */
function dailyReturns(curve: { date: string; value: number }[]): number[] {
  if (curve.length < 2) return [];
  const rs: number[] = [];
  for (let i = 1; i < curve.length; i++) {
    const prev = curve[i - 1].value;
    const cur = curve[i].value;
    if (prev > 0) rs.push((cur - prev) / prev);
  }
  return rs;
}

/** 计算序列偏度（三阶矩标准化） */
function skewness(xs: number[]): number {
  const n = xs.length;
  if (n < 3) return 0;
  const mean = xs.reduce((s, x) => s + x, 0) / n;
  const m2 = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / n;
  const m3 = xs.reduce((s, x) => s + (x - mean) ** 3, 0) / n;
  return m2 > 0 ? m3 / m2 ** 1.5 : 0;
}

/** 计算序列超额峰度（四阶矩标准化 - 3） */
function excessKurtosis(xs: number[]): number {
  const n = xs.length;
  if (n < 4) return 0;
  const mean = xs.reduce((s, x) => s + x, 0) / n;
  const m2 = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / n;
  const m4 = xs.reduce((s, x) => s + (x - mean) ** 4, 0) / n;
  return m2 > 0 ? m4 / m2 ** 2 - 3 : 0;
}

/** 标准正态分布 CDF（近似，Abramowitz-Stegun 7.1.26） */
export function normCDF(x: number): number {
  // Abramowitz-Stegun 近似
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

/** 标准正态分布分位函数（逆 CDF 近似） */
function normInv(p: number): number {
  // Acklam 近似
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const plow = 0.02425;
  const phigh = 1 - plow;
  let q: number, r: number;
  if (p < plow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= phigh) {
    q = p - 0.5;
    r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
}

/**
 * Probabilistic Sharpe Ratio（Bailey-López de Prado 2012）
 * P(真实 SR > 0 | 观察 SR, 样本长度 T, 偏度, 峰度)
 *
 * PSR = Φ( SR / σ_SR )
 * σ_SR² = [1 − γ₃·SR + ((γ₄−1)/4)·SR²] / (T−1)   （Bailey-López de Prado 2012, Mertens 2002）
 * 其中 γ₃ 为偏度、γ₄ 为常规峰度（正态=3）。本函数入参 kurt 为超额峰度（= γ₄−3），
 * 故 (γ₄−1)/4 = (超额峰度+2)/4：正态时超额峰度为 0，退化为 (1 + SR²/2)/(T−1)，与 Lo(2002) 一致。
 */
function probabilisticSharpeRatio(sr: number, T: number, skew: number, kurt: number): number {
  if (T < 2) return 0;
  const sigmaSR = Math.sqrt((1 - skew * sr + ((kurt + 2) / 4) * sr * sr) / (T - 1));
  if (sigmaSR <= 0) return 0;
  return normCDF(sr / sigmaSR);
}

/**
 * N 次标准正态独立抽样最大值的期望 E[max]（Bailey-López de Prado 2014, Eq.5）
 *
 * E[max] = (1−γ)·Φ⁻¹(1 − 1/N) + γ·Φ⁻¹(1 − 1/(N·e))
 *
 * 其中 γ ≈ 0.5772 为 Euler-Mascheroni 常数，Φ⁻¹ 为标准正态分位函数，e 为自然对数的底。
 * 物理含义：在"N 个零真实 alpha 的策略中挑最优"的选择偏差下，最佳策略 Sharpe 的期望抬升（以 σ 为单位）。
 * 两项各用不同的分位点：Φ⁻¹(1−1/N) 与更大的 Φ⁻¹(1−1/(N·e))，在 N 较小时也保持高精度。
 *
 * @param N 策略/搜索次数（≥2；N=1 时无选择偏差，返回 0）
 */
export function expectedMaxOfNormals(N: number): number {
  if (N <= 1) return 0;
  const gamma = 0.5772156649015329; // Euler-Mascheroni 常数
  return (1 - gamma) * normInv(1 - 1 / N) + gamma * normInv(1 - 1 / (N * Math.E));
}

/**
 * Deflated Sharpe Ratio（Bailey-López de Prado 2014, The Journal of Portfolio Management 40(5)）
 * 在 PSR 基础上扣除"试了 N 个策略取最佳"的选择偏差。
 *
 * DSR = PSR(SR_0) = Φ( (SR − SR_0) / σ_SR )
 * SR_0 = σ_SR · E[max] = σ_SR · [(1−γ)·Φ⁻¹(1−1/N) + γ·Φ⁻¹(1−1/(N·e))]   （N>1）
 *
 * σ_SR 与 PSR 相同（含 (γ₄−1)/4 = (超额峰度+2)/4 项）。E[max] 随 N 增大而单调抬升，
 * 因此搜索次数越多 SR_0 越高、DSR 越保守，显著阈值越严格。
 *
 * @param sr 观察到的 Sharpe Ratio（须与 T 的时间单位一致，compareBacktests 传日频）
 * @param N 试过的策略数（搜索空间大小）
 * @param T 样本长度（日数）
 * @param skew 偏度
 * @param kurt 超额峰度（= 常规峰度 − 3）
 */
export function deflatedSharpeRatio(sr: number, N: number, T: number, skew: number, kurt: number): number {
  if (N < 1 || T < 2) return 0;
  const sigmaSR = Math.sqrt((1 - skew * sr + ((kurt + 2) / 4) * sr * sr) / (T - 1));
  if (sigmaSR <= 0) return 0;
  // SR_0 = E[max of N IID SR]：搜索偏差的期望抬升
  const sr0 = sigmaSR * expectedMaxOfNormals(N);
  // DSR = PSR(sr - sr0)
  const adjustedSR = (sr - sr0) / sigmaSR;
  return normCDF(adjustedSR);
}

/**
 * Minimum Track-Record Length（Bailey-López de Prado 2014）
 * 达到 DSR ≥ 1−alpha 所需的最短回测样本长度（单位与 SR 口径对应，年化 SR 则为年数）。
 */
function minTrackRecordLength(sr: number, skew: number, kurt: number, alpha = 0.05): number {
  if (sr === 0) return Infinity;
  // MinTRL = 1 + [1 - skew*SR + ((超额峰度+2)/4) * SR^2] * ln(1/alpha) / SR^2
  // 峰度项与 PSR/DSR 一致：(γ₄−1)/4 = (超额峰度+2)/4
  const numerator = (1 - skew * sr + ((kurt + 2) / 4) * sr * sr) * Math.log(1 / alpha);
  return 1 + numerator / (sr * sr);
}

/**
 * 确定性伪随机数生成器（mulberry32）——保证 bootstrap 可复现
 */
function mulberry32(seed: number): () => number {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Stationary Bootstrap（Politis-Romano 1994）
 * 对差值序列做块重采样，块长服从几何分布（参数 p = 1/expectedBlockLength）
 * 保留时序结构，比 IID bootstrap 更适合金融收益序列
 */
function stationaryBootstrapCI(
  diffs: number[],
  iterations = 2000,
  seed = 42,
): BootstrapResult {
  const n = diffs.length;
  if (n < 2) return { ci95: [0, 0], pValue: 1, iterations: 0, crossesZero: true };
  // 期望块长 ~ 2√n（Politis-Romano 启发式）
  const expectedBlock = Math.max(2, Math.round(2 * Math.sqrt(n)));
  const p = 1 / expectedBlock;
  const rng = mulberry32(seed);
  const means: number[] = [];
  for (let iter = 0; iter < iterations; iter++) {
    let sum = 0;
    let idx = Math.floor(rng() * n);
    for (let i = 0; i < n; i++) {
      sum += diffs[idx];
      // 以概率 p 重新随机选起点，否则继续当前块
      if (rng() < p) {
        idx = Math.floor(rng() * n);
      } else {
        idx = (idx + 1) % n;
      }
    }
    means.push(sum / n);
  }
  means.sort((a, b) => a - b);
  const lo = means[Math.floor(iterations * 0.025)];
  const hi = means[Math.floor(iterations * 0.975)];
  // p 值：bootstrap 均值 ≤ 0 的比例（单尾，检验均值 > 0）
  const nonPositive = means.filter((m) => m <= 0).length;
  const pValue = nonPositive / iterations;
  return {
    ci95: [lo, hi],
    pValue,
    iterations,
    crossesZero: lo <= 0 && hi >= 0,
  };
}

export interface CompareOptions {
  /** 搜索的策略数（用于 DSR 校正），默认 1（单次预注册检验） */
  numStrategiesTried?: number;
  /** Bootstrap 重采样次数，默认 2000 */
  bootstrapIterations?: number;
  /** Bootstrap 随机种子，默认 42（确定性） */
  bootstrapSeed?: number;
}

/**
 * 对比基线与实验组回测结果，量化增量 alpha 是否显著。
 * 两个回测必须基于同一数据/区间（调用方负责保证，否则结论无意义）。
 */
export function compareBacktests(
  baseline: BacktestResult,
  experiment: BacktestResult,
  options?: CompareOptions,
): BacktestComparison {
  const N = options?.numStrategiesTried ?? 1;
  const metricNames: MetricDelta['name'][] = [
    'totalReturn', 'annualizedReturn', 'sharpeRatio', 'sortinoRatio',
    'maxDrawdown', 'winRate', 'profitFactor',
  ];

  const metrics: MetricDelta[] = metricNames.map((name) => {
    const b = baseline[name] ?? 0;
    const e = experiment[name] ?? 0;
    const delta = e - b;
    const improved = name === 'maxDrawdown' ? delta < 0 : delta > 0;
    return { name, baseline: b, experiment: e, delta, improved };
  });

  const alphaAnnualized = (experiment.annualizedReturn ?? 0) - (baseline.annualizedReturn ?? 0);

  // 配对日收益差 t 统计量
  const rBase = dailyReturns(baseline.equityCurve);
  const rExp = dailyReturns(experiment.equityCurve);
  const n = Math.min(rBase.length, rExp.length);
  const caveats: string[] = [];

  let tStatistic = 0;
  let significance: Significance = 'insufficient_sample';
  let nonNormality: NonNormalityDiagnostic | undefined;
  let bootstrap: BootstrapResult | undefined;
  let psr: number | undefined;
  let dsr: number | undefined;
  let minTRL: number | undefined;

  if (n < 30) {
    significance = 'insufficient_sample';
    caveats.push(`样本量不足（仅 ${n} 个配对日收益），统计结论不可靠，需更长回测区间`);
  } else {
    // 配对差序列
    const diffs: number[] = [];
    for (let i = 0; i < n; i++) diffs.push(rExp[i] - rBase[i]);
    const mean = diffs.reduce((s, d) => s + d, 0) / n;
    const variance = diffs.reduce((s, d) => s + (d - mean) ** 2, 0) / (n - 1);
    const std = Math.sqrt(variance);
    tStatistic = std > 0 ? mean / (std / Math.sqrt(n)) : 0;

    // === t 阈值分级（Harvey-Liu-Zhu 2016） ===
    const absT = Math.abs(tStatistic);
    if (absT > 3) {
      significance = 'significant_strong';
    } else if (absT > 2) {
      significance = 'significant_marginal';
      caveats.push(`t=${tStatistic.toFixed(2)} 处于 2-3 区间：单次检验显著但未做多重比较校正，若做了参数搜索需参考 Harvey-Liu-Zhu(2016) t≥3.0 阈值`);
    } else {
      significance = 'not_significant';
    }

    // === 非正态诊断 ===
    const skew = skewness(diffs);
    const kurt = excessKurtosis(diffs);
    const nonNormal = Math.abs(skew) > 1 || kurt > 3;
    nonNormality = {
      skewness: skew,
      excessKurtosis: kurt,
      nonNormal,
      warning: nonNormal
        ? `差值序列偏度=${skew.toFixed(2)} 超额峰度=${kurt.toFixed(2)}，偏离正态假设，t 检验可能不可靠，应参考 Bootstrap CI`
        : '',
    };
    if (nonNormal) caveats.push(nonNormality.warning);

    // === Block Bootstrap CI（非正态时的鲁棒替代） ===
    bootstrap = stationaryBootstrapCI(
      diffs,
      options?.bootstrapIterations ?? 2000,
      options?.bootstrapSeed ?? 42,
    );

    // === DSR / PSR / MinTRL（基于实验组 Sharpe） ===
    // 将年化 Sharpe 转换为日频 Sharpe 用于 DSR 计算
    const expSharpeDaily = (experiment.sharpeRatio ?? 0) / Math.sqrt(252);
    const baseReturns = rExp; // 用实验组收益序列的偏度/峰度
    const expSkew = skewness(baseReturns);
    const expKurt = excessKurtosis(baseReturns);
    psr = probabilisticSharpeRatio(expSharpeDaily, n, expSkew, expKurt);
    dsr = deflatedSharpeRatio(expSharpeDaily, N, n, expSkew, expKurt);
    minTRL = minTrackRecordLength(expSharpeDaily, expSkew, expKurt);

    if (N > 1) {
      caveats.push(`已试 ${N} 个策略变体，DSR=${dsr.toFixed(3)}（已校正搜索偏差）；若 N 实际更大请传入 numStrategiesTried`);
    }
    if (minTRL > 0 && minTRL !== Infinity) {
      const yearsActual = n / 252;
      if (yearsActual < minTRL) {
        caveats.push(`MinTRL=${minTRL.toFixed(1)} 年 > 实际 ${yearsActual.toFixed(1)} 年，回测长度不足以确认 Sharpe 可信`);
      }
    }
    // Bootstrap CI 跨 0 但 t 显著 → 矛盾，以 Bootstrap 为准
    // 此处 significance 不可能为 insufficient_sample（样本不足时已提前 return），仅需排除 not_significant
    if (bootstrap.crossesZero && significance !== 'not_significant') {
      caveats.push(`Bootstrap 95% CI [${bootstrap.ci95[0].toFixed(4)}, ${bootstrap.ci95[1].toFixed(4)}] 跨 0，与 t 检验结论矛盾，以 Bootstrap 为准（更鲁棒）`);
      significance = 'not_significant';
    }
  }

  // === 数据质量提示 ===
  const baseSim = baseline.equityCurve.length === 0;
  const expSim = experiment.equityCurve.length === 0;
  if (baseSim || expSim) {
    caveats.push('某方权益曲线为空，日收益对比可能失真');
  }
  if (baseline.benchmark.length > 0 && experiment.benchmark.length > 0
      && baseline.benchmark.length !== experiment.benchmark.length) {
    caveats.push('两组基准长度不一致，可能未在同一区间回测，对比结论存疑');
  }

  // === 交易成本敏感性 ===
  // A 股 round-trip 典型 0.4%（佣金+滑点+印花税），若实验组交易更频繁需警示
  const expTrades = experiment.tradeCount ?? 0;
  const baseTrades = baseline.tradeCount ?? 0;
  if (expTrades > baseTrades * 1.5 && expTrades > 0) {
    const costRatio = (expTrades * 0.4) / Math.abs(experiment.totalReturn || 1) * 100;
    if (costRatio > 30) {
      caveats.push(`实验组交易次数(${expTrades})显著多于基线(${baseTrades})，按 A 股 0.4% round-trip 估算成本占比约 ${costRatio.toFixed(0)}%，可能侵蚀大部分收益`);
    }
  }

  // === 综合判定 ===
  const improvedCount = metrics.filter((m) => m.improved).length;
  const deterioratedCount = metrics.filter((m) => !m.improved && m.delta !== 0).length;
  let verdict: BacktestComparison['verdict'];
  if (significance === 'insufficient_sample') {
    verdict = 'inconclusive';
  } else if (significance === 'significant_strong' || significance === 'significant_marginal') {
    verdict = alphaAnnualized > 0 ? 'experiment_wins' : alphaAnnualized < 0 ? 'baseline_wins' : 'tie';
  } else {
    verdict = improvedCount > deterioratedCount + 1 ? 'experiment_wins'
      : deterioratedCount > improvedCount + 1 ? 'baseline_wins'
      : 'tie';
  }

  const summary = buildSummary(verdict, significance, alphaAnnualized, tStatistic, improvedCount, metrics.length, dsr, bootstrap);

  const result: BacktestComparison = {
    metrics,
    alphaAnnualized,
    tStatistic,
    significance,
    verdict,
    summary,
    caveats,
  };
  if (nonNormality) result.nonNormality = nonNormality;
  if (psr !== undefined) result.probabilisticSharpeRatio = psr;
  if (dsr !== undefined) result.deflatedSharpeRatio = dsr;
  if (minTRL !== undefined && minTRL !== Infinity) result.minTrackRecordLength = minTRL;
  if (bootstrap) result.bootstrap = bootstrap;
  return result;
}

function buildSummary(
  verdict: BacktestComparison['verdict'],
  significance: Significance,
  alpha: number,
  t: number,
  improved: number,
  total: number,
  dsr?: number,
  bootstrap?: BootstrapResult,
): string {
  const alphaStr = `${alpha >= 0 ? '+' : ''}${alpha.toFixed(2)}pp`;
  const sigStr = significance === 'significant_strong' ? '统计强显著（|t|>3，通过 Harvey-Liu-Zhu 多重检验校正）'
    : significance === 'significant_marginal' ? '统计边际显著（2<|t|≤3，未做多重检验校正，存疑）'
    : significance === 'not_significant' ? '统计不显著'
    : '样本不足';
  const trendStr = `${improved}/${total} 项指标改善`;
  const dsrStr = dsr !== undefined ? `，DSR=${dsr.toFixed(3)}` : '';
  const bootStr = bootstrap ? `，Bootstrap CI [${bootstrap.ci95[0].toFixed(4)}, ${bootstrap.ci95[1].toFixed(4)}]${bootstrap.crossesZero ? '（跨0）' : ''}` : '';
  switch (verdict) {
    case 'experiment_wins':
      return `实验组优于基线：年化超额 ${alphaStr}，${trendStr}，${sigStr}（t=${t.toFixed(2)}${dsrStr}${bootStr}）。LLM 信号带来了可量化的增量 alpha。`;
    case 'baseline_wins':
      return `基线优于实验组：年化差 ${alphaStr}，${trendStr}，${sigStr}（t=${t.toFixed(2)}${dsrStr}${bootStr}）。LLM 信号未带来正贡献，甚至有害，建议回退或重调。`;
    case 'tie':
      return `两组基本持平：年化差 ${alphaStr}，${trendStr}，${sigStr}（t=${t.toFixed(2)}${dsrStr}${bootStr}）。LLM 信号未体现明显增量，需更多数据或调整信号设计。`;
    case 'inconclusive':
    default:
      return `无法下结论：${sigStr}。当前对比仅作参考，需扩大样本量后再评估 LLM 信号是否真增 alpha。`;
  }
}
