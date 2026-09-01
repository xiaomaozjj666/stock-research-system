/**
 * 多因子加权组合 alpha（单只股票，时间序列 IC 口径）
 * --------------------------------------------------------------------------
 * 上一棒 `factorPredictability.ts` 已给出每个量价因子对「这只股票自身」远期收益的
 * 时间序列 IC（ic / effectiveIc = ic×direction / t / p / 显著）。本模块进一步把这些
 * 单因子信号合成一个**方向性组合 alpha**：
 *
 *   - 只纳入达到统计显著（p < 0.05）的因子 —— 不显著的因子等价于「无证据」，纳入只会
 *     引入噪声、助长过拟合，故权重置 0（而非当成「居中」边缘信号参与加权）；
 *   - 每个显著因子的「边」用经济方向 IC（effectiveIc，已把因子方向折算进去，>0 即按
 *     因子预期方向下注真赚到）表示，符号即该因子的预期方向；
 *   - 权重取该因子预测的置信度 |tStat|（信息量 ∝ t），对 effectiveIc 做加权平均：
 *
 *       alpha = Σ(wᵢ · effectiveIcᵢ) / Σ|wᵢ| ,  wᵢ = |tStatᵢ|
 *
 *   合成 alpha ∈ [-1, 1]，符号 = 组合净方向（看多 / 看空），幅度 = 显著因子方向校正 IC
 *   的置信度加权均值，越接近 ±1 表示多因子同向且置信越高。
 *
 * 同时输出：显著因子数、方向一致率（同向显著因子占比，衡量多因子共识强度）、主导贡献
 * 因子（按 |w·effectiveIc| 排序）。跨持有期（21/63）各自结算，再多数表决出综合方向。
 *
 * 全部纯函数、无副作用、零第三方依赖。
 */

import type { OHLCVData } from './types.js';
import {
  evaluatePriceVolumeFactorPredictability,
  type FactorPredictability,
  type FactorPredictabilityHorizon,
} from './factorPredictability.js';
import type { PriceVolumeFactorName } from './priceVolumeFactors.js';

/** 组合方向 */
export type CompositeDirection = 'up' | 'down' | 'neutral';

/** 单因子对组合的贡献（主导项按 |贡献| 排序） */
export interface CompositeContributor {
  name: PriceVolumeFactorName;
  /** 方向校正 IC（含符号） */
  effectiveIc: number;
  /** 置信度权重 = |tStat| */
  weight: number;
  /** 加权贡献 = w · effectiveIc */
  contribution: number;
}

/** 单持有期组合 alpha */
export interface CompositeAlphaHorizon {
  period: number;
  /** 组合方向性 alpha ∈ [-1, 1]，IC 置信度加权均值 */
  alpha: number;
  /** 综合方向：|alpha| 超阈值取 up/down，否则 neutral（信号不足） */
  direction: CompositeDirection;
  /** 达到统计显著的因子数 */
  significantCount: number;
  /** 该持有期下有预测力的因子总数（非 null） */
  evaluableCount: number;
  /** 显著因子方向一致率 = 同向显著因子 / 显著因子数 ∈ [0,1] */
  agreement: number;
  /** 主导贡献因子（按 |贡献| 降序，最多 3 项） */
  topContributors: CompositeContributor[];
}

/** 跨持有期组合 alpha */
export interface CompositeAlpha {
  horizons: CompositeAlphaHorizon[];
  /** 任一持有期有显著信号 */
  hasSignal: boolean;
  /** 综合方向（跨持有期多数表决；平票 / 全中性 → neutral） */
  overallDirection: CompositeDirection;
}

/** 方向判定门槛：|alpha| 大于该值才判 up/down，否则视为信号不足（neutral） */
const DIRECTION_EPSILON = 0.02;

function directionOf(alpha: number): CompositeDirection {
  if (alpha > DIRECTION_EPSILON) return 'up';
  if (alpha < -DIRECTION_EPSILON) return 'down';
  return 'neutral';
}

/**
 * 把单因子时间序列预测力合成方向性组合 alpha。
 *
 * @param predictability 单因子预测力（来自 evaluatePriceVolumeFactorPredictability）；
 *                       无显著因子则该持有期 alpha = 0、方向 neutral
 * @param horizons       持有期（交易日）；默认 [21, 63]
 */
export function computeCompositeAlpha(
  predictability: FactorPredictability[],
  horizons: number[] = [21, 63],
): CompositeAlpha {
  const horizonsOut: CompositeAlphaHorizon[] = horizons.map((period) => {
    const contributors: CompositeContributor[] = [];
    let weightSum = 0;
    let weightedEdge = 0;
    let significantCount = 0;
    let evaluableCount = 0;

    for (const f of predictability) {
      const h: FactorPredictabilityHorizon | null | undefined = f.horizons[period];
      if (!h) continue; // 样本不足 → 无预测力，跳过
      evaluableCount += 1;
      if (!h.significant) continue; // 不显著 → 不纳入加权（避免噪声过拟合）
      significantCount += 1;
      const w = Math.abs(h.tStat);
      const contribution = w * h.effectiveIc;
      weightedEdge += contribution;
      weightSum += w;
      contributors.push({ name: f.name, effectiveIc: h.effectiveIc, weight: w, contribution });
    }

    const alpha = weightSum > 0 ? weightedEdge / weightSum : 0;
    const direction = directionOf(alpha);
    // 方向一致率：显著因子中 effectiveIc 与组合净方向（alpha 符号）同号的比例；
    // alpha 恰为 0（多空抵消）→ 一致率 0（无共识）
    const alphaSign = Math.sign(alpha);
    const sameSignCount =
      significantCount > 0
        ? contributors.filter((c) => Math.sign(c.effectiveIc) === alphaSign).length
        : 0;
    const agreement = significantCount > 0 ? sameSignCount / significantCount : 0;
    const topContributors = [...contributors]
      .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
      .slice(0, 3);

    return {
      period,
      alpha,
      direction,
      significantCount,
      evaluableCount,
      agreement,
      topContributors,
    };
  });

  const hasSignal = horizonsOut.some((h) => h.significantCount > 0);
  // 跨持有期多数表决（只统计 up/down，neutral 不参与投票）
  let up = 0;
  let down = 0;
  for (const h of horizonsOut) {
    if (h.direction === 'up') up += 1;
    else if (h.direction === 'down') down += 1;
  }
  const overallDirection: CompositeDirection = up > down ? 'up' : down > up ? 'down' : 'neutral';

  return { horizons: horizonsOut, hasSignal, overallDirection };
}

/** 便捷入口：直接吃 bars + 可选市场收益，内部复用因子预测力评估 */
export function computeCompositeAlphaFromBars(
  bars: OHLCVData[],
  marketReturns?: number[],
  horizons: number[] = [21, 63],
): CompositeAlpha {
  const pred = evaluatePriceVolumeFactorPredictability({ bars, marketReturns }, horizons);
  return computeCompositeAlpha(pred, horizons);
}
