import type { ValuationData } from '../types.js';

/**
 * 历史分位至少需要两个真实观测点；单个“当前 PE”不能构成历史分布。
 * isEstimated 缺省代表上游提供的真实历史值，显式 true 的估算点只用于展示。
 */
const MIN_ACTUAL_PE_SAMPLES = 2;

/** 返回可参与分位、评分和评级的真实历史 PE，过滤估算值与非法数值。 */
export function actualHistoricalPEValues(valuation: ValuationData): number[] {
  return valuation.historicalPE
    .filter((point) => point.isEstimated !== true && Number.isFinite(point.pe) && point.pe > 0)
    .map((point) => point.pe)
    .sort((a, b) => a - b);
}

/**
 * 计算真实历史 PE 分位。数据不足或当前 PE 无效时返回 null，由调用方决定中性降级与披露，
 * 绝不拿由当前 PE 反推的估算序列制造“历史低估/高估”结论。
 */
export function historicalPEPercentile(valuation: ValuationData): number | null {
  if (valuation.peUnavailable || !Number.isFinite(valuation.pe) || valuation.pe <= 0) return null;
  const values = actualHistoricalPEValues(valuation);
  if (values.length < MIN_ACTUAL_PE_SAMPLES) return null;
  return (values.filter((pe) => pe <= valuation.pe).length / values.length) * 100;
}

/** 是否含有仅供展示的估算历史 PE，供报告和前端统一披露。 */
export function hasEstimatedHistoricalPE(valuation: ValuationData): boolean {
  return valuation.historicalPE.some((point) => point.isEstimated === true);
}
