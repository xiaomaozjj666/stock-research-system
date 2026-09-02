/**
 * 单只股票的量价因子时间序列预测力（Time-Series IC）
 * --------------------------------------------------------------------------
 * `priceVolumeFactors.ts` 给出的是因子在「最新一日」的快照值；但快照回答不了
 * 研究者真正关心的问题——**这个因子对这只股票自身的远期收益到底有没有预测力？**
 *
 * 截面 IC（qlib / alphalens 口径）需要多只股票同日的横截面，单只股票算不了；
 * 单只股票对应的是**时间序列 IC**：把因子在历史上每一日 `t` 的值，与它之后
 * `period` 个交易日的真实收益做秩相关（Spearman），再用 Student t 检验判定
 * 该相关系数是否显著区别于 0。
 *
 * 这与截面 IC 共享同一套统计语言（IC / t / p / 显著），但数据生成过程不同：
 * 截面 IC 赌的是「因子高的股票未来跑赢因子低的股票」；时间序列 IC 赌的是
 * 「因子高的**时点**未来跑赢因子低的时点」——对单一标的的技术/量价因子研究，
 * 后者才是可证伪的口径。
 *
 * 经济方向：因子自带 `direction`（+1 = 值越高预期收益越高）。`effectiveIc = ic × direction`
 * 把统计相关翻成「按因子预期方向下注是否真的赚到」，>0 即因子预期方向与 realization 一致。
 *
 * 全部纯函数、无副作用、零第三方依赖（Student t 双侧 p 来自 factorStats）。
 */

import type { OHLCVData } from './types.js';
import {
  computePriceVolumeFactorSeries,
  type PriceVolumeFactorContext,
  type PriceVolumeFactorName,
  type FactorCategory,
} from './priceVolumeFactors.js';
import { spearmanRankIC } from './factorAnalytics.js';
import { studentTTwoSidedP, holmAdjust } from './factorStats.js';

/** 单因子、单持有期的预测力 */
export interface FactorPredictabilityHorizon {
  /** Spearman 秩相关 IC：factor(t) 与未来 period 日收益的秩相关 ∈ [-1, 1] */
  ic: number;
  /** 经济方向 IC = ic × direction；>0 表示因子预期方向与真实收益一致 */
  effectiveIc: number;
  /** t 统计量：按重叠修正后的有效样本量 nEff 计算（见 nEff 说明） */
  tStat: number;
  /** Student t 双侧 p 值（自由度 nEff − 2） */
  pValue: number;
  /**
   * 跨因子 Holm 校正后的 p 值（家族 = 同一持有期下参与检验的全部因子）。
   * 同一份数据检验 N 个因子时，raw p < 0.05 的家族假阳性率远超 5%；
   * significant 判据使用校正后 p，未做校正前为 undefined。
   */
  pAdj?: number;
  /** pAdj < 0.05 视为统计显著（真实信号，非运气；已经 Holm 多重检验校正） */
  significant: boolean;
  /** 有效样本数（已剔除因子值或收益非有限、或 base/ahead 收盘价非正的截面） */
  n: number;
  /**
   * 重叠修正后的有效样本量 ≈ ceil(n / period)。
   * period 日远期收益在相邻交易日共享 period−1 天数据，n 个观测并非独立——
   * 重叠均值的行为近似 n/period 个独立区块，iid 假设会把 t 统计量高估 √period 倍。
   * period = 1（无重叠）时 nEff = n。
   */
  nEff: number;
}

export interface FactorPredictability {
  name: PriceVolumeFactorName;
  direction: 1 | -1;
  category: FactorCategory;
  /** 持有期（交易日）→ 预测力；样本不足时为 null */
  horizons: Record<number, FactorPredictabilityHorizon | null>;
  /** 是否有任一持有期达到统计显著（该因子对这只股票存在可证伪的预测力） */
  hasSignal: boolean;
}

/**
 * 单因子、单持有期的时间序列 IC 与显著性。
 *
 * @param factorValues 与 closes 等长、按 bars 索引对齐的因子值序列（不足处为 NaN）
 * @param closes       收盘价序列（按日期升序），用于计算远期收益
 * @param direction    因子方向（+1/−1），用于折算 effectiveIc
 * @param period       持有期（交易日）
 * @returns 有效样本 < 3 时返回 null（无法做 t 检验）
 */
export function singleFactorPredictability(
  factorValues: number[],
  closes: number[],
  direction: 1 | -1,
  period: number,
): FactorPredictabilityHorizon | null {
  const n = closes.length;
  const fv: number[] = [];
  const fr: number[] = [];
  for (let j = 0; j + period < n; j++) {
    const f = factorValues[j];
    const base = closes[j];
    const ahead = closes[j + period];
    // 因子值或收盘价非有限/非正 → 该截面不可用，跳过（绝不把缺失洗成 0）
    if (!Number.isFinite(f) || !(base > 0) || !(ahead > 0)) continue;
    const r = ahead / base - 1;
    if (!Number.isFinite(r)) continue;
    fv.push(f);
    fr.push(r);
  }
  const m = fv.length;
  if (m < 3) return null;

  const ic = spearmanRankIC(fv, fr);
  // 重叠修正：period 日远期收益相邻重叠，有效独立样本 ≈ m/period。
  // 不修正会把 t 统计量高估约 √period 倍（period=21 时约 4.6 倍），p 值严重乐观。
  const nEff = Math.max(3, Math.ceil(m / period));
  const denom = 1 - ic * ic;
  // |ic| ≈ 1（完全单调）时 t → ∞；落地为有限大值，p 经 Student t 仍趋于 0
  const tStat = denom > 1e-12 ? ic * Math.sqrt((nEff - 2) / denom) : ic > 0 ? 1e6 : -1e6;
  const pValue = studentTTwoSidedP(tStat, nEff - 2);
  return {
    ic,
    effectiveIc: ic * direction,
    tStat,
    pValue,
    significant: Number.isFinite(pValue) && pValue < 0.05, // raw 判据； Holm 校正后由 evaluate 覆写
    n: m,
    nEff,
  };
}

/**
 * 评估全部量价因子对这只股票自身远期收益的时间序列预测力。
 *
 * 统计严谨性：
 *  - 重叠修正：每个持有期的 t/p 按有效样本量 nEff = ceil(n/period) 计算（见
 *    singleFactorPredictability）；period = 1 时与 iid 完全一致。
 *  - 多重检验校正：同一持有期下全部因子构成一个检验族，p 值经 Holm-Bonferroni
 *    校正（pAdj），significant = pAdj < 0.05——控制在家族错误率 ≤ 5%，
 *    避免「测 11 个因子总能撞出几个假显著」的过拟合。
 *
 * @param ctx      量价因子上下文（bars 必填；marketReturns/floatShares 缺失时 Beta 类等因子值恒 NaN，预测力相应为 null）
 * @param horizons 持有期（交易日）；默认 [21, 63] = 1 个月 / 3 个月
 */
export function evaluatePriceVolumeFactorPredictability(
  ctx: PriceVolumeFactorContext,
  horizons: number[] = [21, 63],
): FactorPredictability[] {
  const seriesList = computePriceVolumeFactorSeries(ctx);
  // 逐日因子序列从 MIN_FACTOR_LOOKBACK 起，points[k] 对应 bars 索引 MIN_FACTOR_LOOKBACK + k
  const startIdx =
    seriesList.length > 0
      ? ctx.bars.findIndex((b) => b.date === seriesList[0].points[0]?.date)
      : -1;
  const closes = ctx.bars.map((b) => b.close);

  const results: FactorPredictability[] = seriesList.map((s) => {
    const values = new Array<number>(closes.length).fill(NaN);
    s.points.forEach((pt, k) => {
      const idx = startIdx >= 0 ? startIdx + k : k;
      if (idx >= 0 && idx < values.length) values[idx] = pt.value;
    });
    const horizonsOut: Record<number, FactorPredictabilityHorizon | null> = {};
    for (const p of horizons) {
      horizonsOut[p] = singleFactorPredictability(values, closes, s.direction, p);
    }
    const hasSignal = Object.values(horizonsOut).some((h) => h && h.significant);
    return {
      name: s.name,
      direction: s.direction,
      category: s.category,
      horizons: horizonsOut,
      hasSignal,
    };
  });

  // 跨因子 Holm 校正（每个持有期一个检验族）：significant 从 raw p 升级为校正后 pAdj
  for (const p of horizons) {
    const family = results.map((r) => r.horizons[p]).filter((h): h is NonNullable<typeof h> => !!h);
    const adjusted = holmAdjust(family.map((h) => h.pValue));
    family.forEach((h, i) => {
      h.pAdj = adjusted[i];
      h.significant = Number.isFinite(h.pAdj) && (h.pAdj as number) < 0.05;
    });
  }
  // hasSignal 以校正后的 significant 重新计算
  for (const r of results) {
    r.hasSignal = Object.values(r.horizons).some((h) => h && h.significant);
  }

  return results;
}

/** 便捷入口：直接吃 bars（无市场收益/流通股本） */
export function evaluatePriceVolumePredictabilityFromBars(
  bars: OHLCVData[],
  horizons: number[] = [21, 63],
): FactorPredictability[] {
  return evaluatePriceVolumeFactorPredictability({ bars }, horizons);
}
