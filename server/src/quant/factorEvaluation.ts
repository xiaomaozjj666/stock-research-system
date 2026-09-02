/**
 * 因子评估（Factor Evaluation）
 * --------------------------------------------------------------------------
 * 补齐「只有 IC 不足以判定因子有效」的那一半评价体系。方法学对齐
 * Quantopian alphalens（活跃分支 alphalens-reloaded）与 microsoft/qlib，
 * 聚宽 jqfactor_analyzer 是 alphalens 的 A 股化 fork，口径一致但版本更旧，
 * 故直接对齐上游而非其 fork。
 *
 * 四大能力：
 *   1. 分层回测  —— 截面按因子值分 N 档，看各档收益是否单调、多空价差多大。
 *                   IC 好但收益全来自一端、档位不单调的因子是典型「假因子」，
 *                   只看 IC 会把这类因子误判为有效。
 *   2. IC 显著性 —— t 统计量与双侧 p 值。样本少时 IR 极易被噪声撑高，
 *                   必须做显著性检验才能把「真实 alpha」与「运气」分开。
 *   3. 换手率与自相关 —— 决定因子 alpha 能否覆盖交易成本，也给出自然调仓周期。
 *   4. 市值/行业中性化 —— 剔除风格与行业暴露后的纯净因子（回归取残差）。
 *
 * 与 factorAnalytics 的分工：factorAnalytics 负责「多因子加权与组合打分」
 * （Grinold & Kahn 框架）；本模块负责「单个因子的有效性诊断」。两者口径一致，
 * 均按「每日截面」而非全样本混算（跨期秩混合会扭曲 IC，见 qlib calc_ic）。
 *
 * 所有导出函数为纯函数，无副作用，可独立单测。
 */
import { spearmanRankIC, averageRanks } from './factorAnalytics.js';
import {
  neweyWestTStat,
  olsRegression,
  sampleExcessKurtosis,
  sampleSkewness,
  studentTTwoSidedP,
  winsorizeMad,
} from './factorStats.js';

/** 一年的交易日数（用于年化 alpha） */
const TRADING_DAYS_PER_YEAR = 252;

/** 单个因子观测：某标的在某日的因子值与其未来各持有期收益 */
export interface FactorObservation {
  /** 交易日（YYYY-MM-DD） */
  date: string;
  /** 标的代码；换手率与自相关分析必需 */
  symbol?: string;
  /** 因子原始值；NaN/Infinity 表示该样本缺失，将被丢弃 */
  value: number;
  /**
   * 未来持有期收益（小数，如 0.012 = +1.2%）。
   * 键为持有期（交易日数），如 { 1: 0.012, 5: 0.031, 10: 0.055 }。
   * 任一被选中的持有期缺失/非有限 → 整行丢弃（与 alphalens 一致）。
   */
  returns: Record<number, number>;
  /** 总市值（亿元）；中性化用 */
  marketCap?: number;
  /** 行业分组标签；中性化与行业中性收益用 */
  group?: string;
  /** 组合权重；缺省按等权处理 */
  weight?: number;
}

/** 清洗后的观测：adjusted 为去极值/中性化之后实际参与分析的因子值 */
export interface CleanedObservation extends FactorObservation {
  adjusted: number;
}

export interface CleanOptions {
  /** 允许丢弃的最大比例 ∈ [0,1]；超出抛错。默认 0.25（alphalens 默认） */
  maxLoss?: number;
  /** 是否按「log 市值 + 行业哑变量」做截面中性化，默认 false */
  neutralize?: boolean;
  /** 是否先做 MAD 去极值（median ± 3×1.4826×MAD），默认 false */
  winsorize?: boolean;
  /** 只保留这些持有期；缺省取数据中出现的全部持有期 */
  periods?: number[];
}

export interface CleanResult {
  rows: CleanedObservation[];
  /** 被丢弃的样本数 */
  dropped: number;
  /** 丢弃比例 ∈ [0,1] */
  dropRatio: number;
  /** 实际参与分析的持有期（升序） */
  periods: number[];
  /** 中性化是否真的生效（缺市值与行业数据时为 false） */
  neutralized: boolean;
}

function isFiniteOrFalse(v: number | undefined): boolean {
  return typeof v === 'number' && Number.isFinite(v);
}

/** 按日期分组（保持输入顺序，键按首次出现顺序） */
function groupByDate<T extends { date: string }>(rows: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const list = out.get(row.date);
    if (list) list.push(row);
    else out.set(row.date, [row]);
  }
  return out;
}

/**
 * 清洗因子面板。
 * 顺序：丢弃缺失 → （可选）去极值 → （可选）中性化。
 *
 * 丢弃规则与 alphalens `get_clean_factor_and_forward_returns` 一致：
 * 因子值非有限、或任一选中持有期收益非有限的整行剔除；当丢弃比例超过 maxLoss
 * 时抛错——静默接受大面积缺失会让 IC 与分层收益失真，宁可让调用方显式放宽阈值。
 */
export function cleanFactorPanel(
  observations: FactorObservation[],
  opts: CleanOptions = {},
): CleanResult {
  const maxLoss = opts.maxLoss ?? 0.25;

  // 收集数据中出现的全部持有期
  const periodSet = new Set<number>();
  for (const row of observations) {
    for (const key of Object.keys(row.returns ?? {})) {
      const p = Number(key);
      if (Number.isFinite(p)) periodSet.add(p);
    }
  }
  const allPeriods = Array.from(periodSet).sort((a, b) => a - b);
  const periods = opts.periods?.length
    ? opts.periods.filter((p) => periodSet.has(p)).sort((a, b) => a - b)
    : allPeriods;

  const kept: CleanedObservation[] = [];
  let dropped = 0;
  for (const row of observations) {
    const hasValue = Number.isFinite(row.value);
    const hasReturns =
      periods.length > 0 && periods.every((p) => isFiniteOrFalse(row.returns?.[p]));
    if (hasValue && hasReturns) kept.push({ ...row, adjusted: row.value });
    else dropped++;
  }

  const dropRatio = observations.length > 0 ? dropped / observations.length : 0;
  if (dropRatio > maxLoss) {
    throw new Error(
      `因子数据缺失过大：丢弃 ${dropped}/${observations.length}（${(dropRatio * 100).toFixed(1)}%），` +
        `超过 maxLoss=${(maxLoss * 100).toFixed(1)}%。请检查数据源或显式放宽 maxLoss。`,
    );
  }

  if (opts.winsorize) {
    for (const [, list] of groupByDate(kept)) {
      const adjusted = winsorizeMad(list.map((r) => r.adjusted));
      list.forEach((row, i) => {
        row.adjusted = adjusted[i];
      });
    }
  }

  let neutralized = false;
  if (opts.neutralize) {
    neutralized = neutralizeInPlace(kept);
  }

  return { rows: kept, dropped, dropRatio, periods, neutralized };
}

/**
 * 截面中性化：对每个交易日，把因子值对「截距 + log(市值) + 行业哑变量」做 OLS，
 * 用残差替换因子值，从而剔除规模效应与行业效应。
 *
 * A 股小市值效应极强，不做中性化时大量因子的 IC 其实是市值因子的影子。
 * 哑变量取 K−1 个（第一个分组作参照组）以避免与截距完全共线。
 *
 * @returns 是否真的执行了中性化（既无市值也无行业信息时不生效，返回 false）
 */
function neutralizeInPlace(rows: CleanedObservation[]): boolean {
  const anyCap = rows.some((r) => isFiniteOrFalse(r.marketCap) && (r.marketCap as number) > 0);
  const groups = Array.from(
    new Set(
      rows.map((r) => r.group).filter((g): g is string => typeof g === 'string' && g.length > 0),
    ),
  ).sort();
  if (!anyCap && groups.length === 0) return false;

  for (const [, list] of groupByDate(rows)) {
    if (list.length < 3) continue;
    const predictors: number[][] = [];
    if (anyCap) {
      predictors.push(
        list.map((r) =>
          isFiniteOrFalse(r.marketCap) && (r.marketCap as number) > 0
            ? Math.log(r.marketCap as number)
            : 0,
        ),
      );
    }
    // 行业哑变量：跳过第一个分组作参照组，避免与截距共线
    for (let g = 1; g < groups.length; g++) {
      const name = groups[g];
      predictors.push(list.map((r) => (r.group === name ? 1 : 0)));
    }
    const y = list.map((r) => r.adjusted);
    const { residuals, fullRank } = olsRegression(y, predictors);
    // 退化（样本不足以估计参数）时保留原值，不引入伪中性化结果
    if (!fullRank) continue;
    list.forEach((row, i) => {
      row.adjusted = residuals[i];
    });
  }
  return true;
}

/** 分档后的观测 */
export interface QuantizedObservation extends CleanedObservation {
  /** 分位档号 ∈ [1, quantiles]；1 = 因子值最低档 */
  quantile: number;
}

/**
 * 按交易日截面把因子值分为 N 档（1 = 最低档）。
 * 并列值取平均秩以保证同值落在同一档；某日样本数少于档数时会有空档。
 */
export function assignQuantiles(
  rows: CleanedObservation[],
  quantiles: number,
): QuantizedObservation[] {
  const n = Math.max(1, Math.floor(quantiles));
  const out: QuantizedObservation[] = rows.map((r) => ({ ...r, quantile: 1 }));
  // 按日期分组时同时记录下标，避免 rows.indexOf(...) 造成的 O(N²) 扫描
  const indexByDate = new Map<string, number[]>();
  rows.forEach((row, i) => {
    const list = indexByDate.get(row.date);
    if (list) list.push(i);
    else indexByDate.set(row.date, [i]);
  });
  for (const [, idxs] of indexByDate) {
    const ranks = averageRanks(idxs.map((i) => rows[i].adjusted));
    const len = idxs.length;
    for (let k = 0; k < len; k++) {
      out[idxs[k]].quantile = 1 + Math.min(n - 1, Math.floor((ranks[k] * n) / len));
    }
  }
  return out;
}

/** 分档收益表的一行 */
export interface QuantileRow {
  /** 档号 ∈ [1, quantiles] */
  quantile: number;
  /** 落入该档的样本数 */
  count: number;
  /** 加权平均周期收益（小数） */
  meanReturn: number;
  /** 收益标准差（样本口径） */
  stdReturn: number;
}

export interface QuantileReturnTable {
  period: number;
  rows: QuantileRow[];
  /** 多空价差 = 最高档收益 − 最低档收益（小数） */
  spread: number;
  /**
   * 单调性 ∈ [−1,1]：档号序列与各档平均收益的 Spearman 秩相关。
   * 接近 +1 表示「因子值越高收益越高」的严格单调关系，是因子有效的最强证据；
   * 接近 0 或为负说明收益集中在某一端或呈 U 形——这类因子即便 IC 不错也不应采信。
   */
  monotonicity: number;
}

export interface QuantileOptions {
  /** 持有期 */
  period: number;
  /** 分档数，默认 5 */
  quantiles?: number;
  /** 是否用「减去当日截面加权平均收益」后的超额收益，默认 false */
  demeaned?: boolean;
  /** 是否用「减去当日所属行业平均收益」后的行业中性收益，默认 false */
  groupAdjust?: boolean;
}

/** 取观测在指定持有期的收益 */
function returnAt(row: CleanedObservation, period: number): number {
  return row.returns[period] ?? 0;
}

/** 加权均值；权重缺省 1（等权）。权重和 ≤ 0 时退化为算术均值 */
function weightedMean(values: number[], weights: number[]): number {
  const wSum = weights.reduce((a, b) => a + b, 0);
  if (wSum > 0) return values.reduce((s, v, i) => s + v * weights[i], 0) / wSum;
  return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

/**
 * 分层回测：按因子值分档后统计各档的平均收益、多空价差与单调性。
 * 这是因子分析的第一张表——alphalens 的 plot_quantile_returns_bar 与
 * qlib 的 Cumulative Return of groups 都是它。
 */
export function quantileReturns(
  rows: CleanedObservation[],
  opts: QuantileOptions,
): QuantileReturnTable {
  const { period, quantiles = 5, demeaned = false, groupAdjust = false } = opts;
  const quantized = assignQuantiles(rows, quantiles);

  // 需要时先算出每日截面基准收益（用于 demean / groupAdjust）
  const adjusted = new Map<CleanedObservation, number>();
  if (demeaned || groupAdjust) {
    for (const [, list] of groupByDate(quantized)) {
      const rets = list.map((r) => returnAt(r, period));
      const wts = list.map((r) => r.weight ?? 1);
      const dateMean = weightedMean(rets, wts);
      if (groupAdjust) {
        const byGroup = new Map<string, CleanedObservation[]>();
        for (const row of list) {
          const key = row.group ?? '__all__';
          const g = byGroup.get(key);
          if (g) g.push(row);
          else byGroup.set(key, [row]);
        }
        for (const [, gl] of byGroup) {
          const grets = gl.map((r) => returnAt(r, period));
          const gwts = gl.map((r) => r.weight ?? 1);
          const gMean = gl.length >= 2 ? weightedMean(grets, gwts) : dateMean;
          for (const row of gl) adjusted.set(row, returnAt(row, period) - gMean);
        }
      } else {
        for (const row of list) adjusted.set(row, returnAt(row, period) - dateMean);
      }
    }
  }

  const buckets = new Map<number, { rets: number[]; wts: number[] }>();
  for (const row of quantized) {
    const r = adjusted.get(row) ?? returnAt(row, period);
    const b = buckets.get(row.quantile);
    if (b) {
      b.rets.push(r);
      b.wts.push(row.weight ?? 1);
    } else {
      buckets.set(row.quantile, { rets: [r], wts: [row.weight ?? 1] });
    }
  }

  const table: QuantileRow[] = Array.from(buckets.entries())
    .map(([quantile, b]) => {
      const mean = weightedMean(b.rets, b.wts);
      const variance =
        b.rets.length > 0 ? b.rets.reduce((s, v) => s + (v - mean) ** 2, 0) / b.rets.length : 0;
      return { quantile, count: b.rets.length, meanReturn: mean, stdReturn: Math.sqrt(variance) };
    })
    .sort((a, b) => a.quantile - b.quantile);

  const spread = table.length >= 2 ? table[table.length - 1].meanReturn - table[0].meanReturn : 0;
  // 单调性：档号与各档收益的秩相关；不足 3 档时无法判定，返回 0
  const monotonicity =
    table.length >= 3
      ? spearmanRankIC(
          table.map((r) => r.quantile),
          table.map((r) => r.meanReturn),
        )
      : 0;

  return { period, rows: table, spread, monotonicity };
}

export interface IcSignificance {
  /** IC 序列长度（参与计算的天数） */
  n: number;
  /** IC 均值 */
  mean: number;
  /** IC 标准差（样本口径，ddof=1，与 alphalens 一致） */
  std: number;
  /** 信息比率 IR = mean / std；std=0 时按符号给极大值（与 factorAnalytics 同口径） */
  ir: number;
  /** t 统计量；启用 Newey-West 时为 HAC 修正值（见 nwMaxLag） */
  tStat: number;
  /**
   * 双侧 p 值（H₀: IC = 0）。
   * p < 0.05 是「IC 显著非零」的常用判据——比 |IR| ≥ 0.3 之类的硬阈值更可靠，
   * 因为它把样本量纳入了考量。
   */
  pValue: number;
  /** IC 分布偏度 */
  skew: number;
  /** IC 分布超额峰度（正态 = 0） */
  excessKurtosis: number;
  /** Newey-West 修正使用的最大滞后阶（= period − 1，重叠持有期的自相关修正）；0/缺省 = iid */
  nwMaxLag?: number;
}

/**
 * 计算每日截面 IC 序列：对每个交易日，取该日所有样本的因子值与未来收益的
 * Spearman 秩相关。组内样本 < 2 的日子无法计算，跳过（qlib calc_ic 同口径）。
 */
export function dailyIcSeries(rows: CleanedObservation[], period: number): number[] {
  const out: number[] = [];
  for (const [, list] of groupByDate(rows)) {
    if (list.length < 2) continue;
    out.push(
      spearmanRankIC(
        list.map((r) => r.adjusted),
        list.map((r) => returnAt(r, period)),
      ),
    );
  }
  return out;
}

/**
 * IC 显著性检验。仅有 IR 无法判断因子是否真的有效——样本量小时 IR 极易被噪声撑高，
 * 必须配合 t 统计量与 p 值（qlib 给出 IC/ICIR，alphalens 给出 t-stat/p-value，
 * 本函数把两者合并）。
 *
 * Newey-West 修正（opts.maxLag > 0 时启用）：period 日远期收益在相邻交易日的
 * IC 序列存在自相关（相邻窗口共享 period−1 天数据），iid 假设会低估标准误、
 * 高估 t 统计量。maxLag 取 period − 1，用 Bartlett 核 HAC 修正长期方差。
 */
export function icSignificance(icSeries: number[], opts: { maxLag?: number } = {}): IcSignificance {
  const clean = icSeries.filter((v) => Number.isFinite(v));
  const n = clean.length;
  if (n === 0) {
    return { n: 0, mean: 0, std: 0, ir: 0, tStat: 0, pValue: 1, skew: 0, excessKurtosis: 0 };
  }
  const mean = clean.reduce((a, b) => a + b, 0) / n;
  // n < 2 时样本方差无定义，返回 0（而非退化为总体方差 0 造成 IR 虚高）
  const std = n >= 2 ? Math.sqrt(clean.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1)) : 0;
  // std = 0（IC 序列恒为同一常数，仅退化/合成数据会出现）：t 统计量在数学上发散。
  // 与 factorAnalytics.informationRatio 的既有约定保持一致——按符号给 ±99 而非 Infinity，
  // 避免 Infinity 序列化进 JSON；此时 IC 恒定非零，显著性应判为极强（p = 0），
  // 绝不能退回 p = 1（那会把「每天 IC 都是 +1」误报为不显著）。
  const degenerate = std === 0 && n >= 2 && mean !== 0;
  const ir = std > 0 ? mean / std : degenerate ? Math.sign(mean) * 99 : 0;

  const maxLag = opts.maxLag ?? 0;
  const iidT =
    std > 0 && n >= 2 ? mean / (std / Math.sqrt(n)) : degenerate ? Math.sign(mean) * 99 : 0;
  let tStat = iidT;
  let pValue = std > 0 && n >= 2 ? studentTTwoSidedP(iidT, n - 1) : degenerate ? 0 : 1;
  let nwMaxLag: number | undefined;
  if (maxLag > 0 && n > maxLag + 2) {
    // Newey-West HAC：自相关下 iid se 低估，改用 HAC 长期方差；
    // NW 退化（se ≤ 0 / NaN）时回退 iid 结果，绝不因此把因子误判为不显著
    const tNw = neweyWestTStat(clean, maxLag);
    if (Number.isFinite(tNw)) {
      tStat = tNw;
      // 自由度取 n − 1（statsmodels HAC 对均值模型同口径）；仍用 Student t 分布
      pValue = studentTTwoSidedP(tNw, n - 1);
      nwMaxLag = maxLag;
    }
  }
  return {
    n,
    mean,
    std,
    ir,
    tStat,
    pValue,
    skew: sampleSkewness(clean),
    excessKurtosis: sampleExcessKurtosis(clean),
    ...(nwMaxLag !== undefined ? { nwMaxLag } : {}),
  };
}

export interface TurnoverResult {
  /** 各档平均换手率 ∈ [0,1]：本期新进入该档的标的占比 */
  byQuantile: Record<number, number>;
  /** 因子排序的平均自相关（滞后 lag 个截面） */
  rankAutocorrelation: number;
  /** 参与计算的日期对数 */
  datePairs: number;
}

export interface TurnoverOptions {
  /** 分档数，默认 5 */
  quantiles?: number;
  /** 自相关与换手率的滞后期（截面数），默认 1 */
  lag?: number;
}

/**
 * 因子换手率与自相关。
 *
 * 换手率决定因子 alpha 能否覆盖交易成本：一个 IC 0.05 但每期换手 80% 的因子，
 * 扣掉 A 股双边成本后大概率不赚钱。本项目的 CostModel 可直接把换手率换算成成本拖累。
 *
 * 自相关给出自然调仓周期：因子排序自相关跌到 0.5 以下时的滞后期，就是该因子的
 * 有效持有期上限——再长就是在给噪声付手续费。
 *
 * 需要观测带 symbol；缺失时返回 null（无法跨期配对）。
 */
export function factorTurnover(
  rows: CleanedObservation[],
  opts: TurnoverOptions = {},
): TurnoverResult | null {
  const { quantiles = 5, lag = 1 } = opts;
  if (!rows.every((r) => typeof r.symbol === 'string' && r.symbol.length > 0)) return null;

  const byDate = groupByDate(rows);
  const dates = Array.from(byDate.keys()).sort();
  if (dates.length < 2) return null;

  const quantized = assignQuantiles(rows, quantiles);
  const quantOf = new Map<CleanedObservation, number>();
  quantized.forEach((q, i) => quantOf.set(rows[i], q.quantile));

  const turnoverSums = new Map<number, number>();
  const turnoverCounts = new Map<number, number>();
  const autocorrs: number[] = [];
  let pairs = 0;

  for (let i = 0; i + lag < dates.length; i++) {
    const prev = byDate.get(dates[i]) as CleanedObservation[];
    const curr = byDate.get(dates[i + lag]) as CleanedObservation[];
    pairs++;

    // 换手率：按档比较成分变化
    const prevByQuant = new Map<number, Set<string>>();
    for (const row of prev) {
      const q = quantOf.get(row) ?? 0;
      const s = prevByQuant.get(q) ?? new Set<string>();
      s.add(row.symbol as string);
      prevByQuant.set(q, s);
    }
    const currByQuant = new Map<number, Set<string>>();
    for (const row of curr) {
      const q = quantOf.get(row) ?? 0;
      const s = currByQuant.get(q) ?? new Set<string>();
      s.add(row.symbol as string);
      currByQuant.set(q, s);
    }
    for (const [q, currSet] of currByQuant) {
      const prevSet = prevByQuant.get(q);
      if (!prevSet || prevSet.size === 0) continue;
      let added = 0;
      for (const sym of currSet) if (!prevSet.has(sym)) added++;
      turnoverSums.set(q, (turnoverSums.get(q) ?? 0) + added / prevSet.size);
      turnoverCounts.set(q, (turnoverCounts.get(q) ?? 0) + 1);
    }

    // 因子排序自相关：仅用两期都出现的标的
    const prevRank = new Map<string, number>();
    for (const row of prev) prevRank.set(row.symbol as string, row.adjusted);
    const xs: number[] = [];
    const ys: number[] = [];
    for (const row of curr) {
      const v0 = prevRank.get(row.symbol as string);
      if (v0 !== undefined && Number.isFinite(v0)) {
        xs.push(v0);
        ys.push(row.adjusted);
      }
    }
    if (xs.length >= 3) {
      const ic = spearmanRankIC(xs, ys);
      if (Number.isFinite(ic)) autocorrs.push(ic);
    }
  }

  const byQuantile: Record<number, number> = {};
  for (const [q, sum] of turnoverSums) {
    const c = turnoverCounts.get(q) ?? 0;
    if (c > 0) byQuantile[q] = sum / c;
  }

  return {
    byQuantile,
    rankAutocorrelation:
      autocorrs.length > 0 ? autocorrs.reduce((a, b) => a + b, 0) / autocorrs.length : 0,
    datePairs: pairs,
  };
}

/** 因子加权多空组合的单日收益 */
export interface FactorReturnPoint {
  date: string;
  /** 当日组合收益（小数） */
  ret: number;
  /** 累计净值，起始 1 */
  cumulative: number;
}

export interface FactorReturnOptions {
  period: number;
  /** 组合权重是否去均值（现金中性多空组合），默认 true */
  demeaned?: boolean;
  /** 权重是否按行业去均值（行业中性多空组合），默认 false */
  groupAdjust?: boolean;
}

/**
 * 因子加权多空组合收益序列（alphalens calc_factor_returns 同口径）。
 * 权重 = 去均值后的因子值 / Σ|权重|，即单位总敞口的现金中性组合；
 * 组合收益 = Σ wᵢ × rᵢ。开 groupAdjust 时改为按行业去均值，得到行业中性组合。
 */
export function factorReturns(
  rows: CleanedObservation[],
  opts: FactorReturnOptions,
): FactorReturnPoint[] {
  const { period, demeaned = true, groupAdjust = false } = opts;
  const out: FactorReturnPoint[] = [];
  let cumulative = 1;
  for (const [date, list] of groupByDate(rows)) {
    if (list.length < 2) continue;
    const weights = list.map((r) => r.adjusted);
    if (demeaned || groupAdjust) {
      const wts = list.map((r) => r.weight ?? 1);
      if (groupAdjust) {
        const byGroup = new Map<string, number[]>();
        list.forEach((row, i) => {
          const key = row.group ?? '__all__';
          const g = byGroup.get(key);
          if (g) g.push(i);
          else byGroup.set(key, [i]);
        });
        const dateMean = weightedMean(weights, wts);
        for (const [, idxs] of byGroup) {
          const sub = idxs.map((i) => weights[i]);
          const subW = idxs.map((i) => wts[i]);
          const gMean = idxs.length >= 2 ? weightedMean(sub, subW) : dateMean;
          for (const i of idxs) weights[i] -= gMean;
        }
      } else {
        const mean = weightedMean(weights, wts);
        for (let i = 0; i < weights.length; i++) weights[i] -= mean;
      }
    }
    const absSum = weights.reduce((s, w) => s + Math.abs(w), 0);
    if (!(absSum > 0)) continue;
    let ret = 0;
    for (let i = 0; i < list.length; i++) {
      ret += (weights[i] / absSum) * returnAt(list[i], period);
    }
    cumulative *= 1 + ret;
    out.push({ date, ret, cumulative });
  }
  return out;
}

export interface FactorAlphaBeta {
  /** 年化 alpha（小数） */
  alpha: number;
  /** 对市场（等权全市场收益）的 beta */
  beta: number;
  r2: number;
}

/**
 * 因子组合的 alpha / beta（alphalens calc_factor_alpha_beta 同口径）：
 * 把因子加权组合收益对「当日等权全市场收益」做 OLS，
 * 回归式 ret = α_daily + β × market，α 年化后输出。
 * 样本 < 3 天或市场收益无波动时返回 null（无法估计）。
 */
export function factorAlphaBeta(
  rows: CleanedObservation[],
  points: FactorReturnPoint[],
  period: number,
  periodsPerYear = TRADING_DAYS_PER_YEAR,
): FactorAlphaBeta | null {
  if (points.length < 3) return null;
  // 市场收益：当日截面的等权平均收益
  const marketByDate = new Map<string, number>();
  for (const [date, list] of groupByDate(rows)) {
    const rets = list.map((r) => returnAt(r, period));
    marketByDate.set(date, rets.reduce((a, b) => a + b, 0) / rets.length);
  }
  const y: number[] = [];
  const x: number[] = [];
  for (const p of points) {
    const m = marketByDate.get(p.date);
    if (m !== undefined && Number.isFinite(m)) {
      y.push(p.ret);
      x.push(m);
    }
  }
  if (y.length < 3) return null;
  const { coefficients, r2, fullRank } = olsRegression(y, [x]);
  if (!fullRank) return null;
  return { alpha: coefficients[0] * periodsPerYear, beta: coefficients[1], r2 };
}

/** 单个持有期的完整评估报告 */
/** 因子样本外稳定性（walk-forward 简化口径） */
export interface OosStability {
  /** 样本内（前 isRatio 段）IC 均值 */
  isMeanIc: number;
  /** 样本外（后 1−isRatio 段）IC 均值 */
  oosMeanIc: number;
  /** 两段 IC 均值同号（方向在时间上稳定） */
  signAgree: boolean;
  /** 样本内显著（NW 修正口径，与主报告一致） */
  isSignificant: boolean;
  /** 样本外显著 */
  oosSignificant: boolean;
  /** 方向且显著双双成立 → 判定稳定 */
  stable: boolean;
  /** 样本内/外各自的 IC 天数 */
  isN: number;
  oosN: number;
}

/**
 * 样本外稳定性复核：把逐日 IC 序列切成前 isRatio / 后 (1−isRatio) 两段，
 * 分别做显著性检验（与主报告同口径的 Newey-West 修正），要求「方向同号且两段都显著」
 * 才判定因子稳定——全样本显著可能只是样本内一段行情撑起来的，OOS 复核能戳破它。
 *
 * @param isRatio 样本内占比，默认 0.7（样本外保留最新 30%）
 */
export function oosStability(
  icSeries: number[],
  opts: { maxLag?: number; isRatio?: number } = {},
): OosStability {
  const clean = icSeries.filter((v) => Number.isFinite(v));
  const ratio = opts.isRatio ?? 0.7;
  const isLen = Math.max(3, Math.floor(clean.length * ratio));
  const isSeg = clean.slice(0, isLen);
  const oosSeg = clean.slice(isLen);
  const isSig = icSignificance(isSeg, opts);
  const oosSig = icSignificance(oosSeg, opts);
  const signAgree =
    isSeg.length >= 3 &&
    oosSeg.length >= 3 &&
    Math.sign(isSig.mean) !== 0 &&
    Math.sign(isSig.mean) === Math.sign(oosSig.mean);
  const isSignificant = isSig.pValue < 0.05;
  const oosSignificant = oosSig.pValue < 0.05;
  return {
    isMeanIc: isSig.mean,
    oosMeanIc: oosSig.mean,
    signAgree,
    isSignificant,
    oosSignificant,
    stable: signAgree && isSignificant && oosSignificant,
    isN: isSeg.length,
    oosN: oosSeg.length,
  };
}

export interface FactorPeriodReport {
  period: number;
  /** 有效样本数 */
  sampleSize: number;
  /** IC 显著性 */
  ic: IcSignificance;
  /** 样本外稳定性复核（前 70% vs 后 30% 的 IC 方向与显著性） */
  oos: OosStability;
  /** 分层回测 */
  quantile: QuantileReturnTable;
  /** 换手率与自相关；缺 symbol 或不足两个截面时为 null */
  turnover: TurnoverResult | null;
  /** 因子加权多空组合的 alpha/beta；样本不足时为 null */
  alphaBeta: FactorAlphaBeta | null;
  /** 多空组合累计净值（起始 1） */
  longShortCumulative: number;
}

export interface EvaluateOptions extends CleanOptions {
  /** 分档数，默认 5（alphalens 默认） */
  quantiles?: number;
  /** 换手率/自相关的滞后期，默认 1 */
  lag?: number;
  /** 收益是否按当日截面去均值，默认 false */
  demeaned?: boolean;
  /** 收益是否按行业去均值，默认 false */
  groupAdjust?: boolean;
}

export interface FactorEvaluationReport {
  /** 参与分析的持有期（升序） */
  periods: number[];
  byPeriod: FactorPeriodReport[];
  /** 有效样本数（各期共用同一份清洗结果） */
  sampleSize: number;
  dropped: number;
  dropRatio: number;
  neutralized: boolean;
}

/**
 * 单因子完整评估：一次给出 IC 显著性、分层回测、换手率与 alpha/beta。
 * 这是本模块的主入口，对应 alphalens 的 create_full_tear_sheet 的量化部分
 * （图表部分由前端渲染，本模块只产出数值）。
 */
export function evaluateFactor(
  observations: FactorObservation[],
  opts: EvaluateOptions = {},
): FactorEvaluationReport {
  const { quantiles = 5, lag = 1, demeaned = false, groupAdjust = false } = opts;
  const cleaned = cleanFactorPanel(observations, opts);
  const rows = cleaned.rows;

  const byPeriod: FactorPeriodReport[] = cleaned.periods.map((period) => {
    // Newey-West：period 日远期收益相邻重叠（共享 period−1 天），IC 序列自相关，
    // iid 假设会低估标准误、高估 t。maxLag = period − 1 做 Bartlett 核 HAC 修正。
    const icSeries = dailyIcSeries(rows, period);
    const maxLag = Math.max(0, period - 1);
    const ic = icSignificance(icSeries, { maxLag });
    const oos = oosStability(icSeries, { maxLag });
    const quantile = quantileReturns(rows, { period, quantiles, demeaned, groupAdjust });
    const turnover = factorTurnover(rows, { quantiles, lag });
    const points = factorReturns(rows, { period, demeaned: true, groupAdjust });
    const alphaBeta = factorAlphaBeta(rows, points, period);
    return {
      period,
      sampleSize: rows.length,
      ic,
      oos,
      quantile,
      turnover,
      alphaBeta,
      longShortCumulative: points.length > 0 ? points[points.length - 1].cumulative : 1,
    };
  });

  return {
    periods: cleaned.periods,
    byPeriod,
    sampleSize: rows.length,
    dropped: cleaned.dropped,
    dropRatio: cleaned.dropRatio,
    neutralized: cleaned.neutralized,
  };
}

/**
 * 判断是否应采信该因子：IC 统计显著 + 分层收益单调 + 多空价差为正。
 * 三条同时成立才算「有效」——只满足 IC 显著而单调性差的因子，
 * 收益往往集中在单侧尾部，实盘不可用。
 */
export interface FactorVerdict {
  effective: boolean;
  /** 未通过的原因；effective 为 true 时为空数组 */
  reasons: string[];
}

export function judgeFactor(report: FactorPeriodReport): FactorVerdict {
  const reasons: string[] = [];
  if (report.ic.n < 5) reasons.push(`IC 样本仅 ${report.ic.n} 期，不足以判定显著性`);
  else if (report.ic.pValue >= 0.05) {
    reasons.push(`IC 未通过显著性检验（p=${report.ic.pValue.toFixed(3)} ≥ 0.05）`);
  }
  if (report.quantile.rows.length < 3) reasons.push('分档数不足 3，无法检验单调性');
  else if (report.quantile.monotonicity < 0.6) {
    reasons.push(`分档收益单调性偏弱（${report.quantile.monotonicity.toFixed(2)} < 0.60）`);
  }
  if (report.quantile.spread <= 0) reasons.push('多空价差非正，因子方向不成立');
  return { effective: reasons.length === 0, reasons };
}
