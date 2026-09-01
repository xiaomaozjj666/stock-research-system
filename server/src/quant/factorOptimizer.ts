import {
  validateFactorModel,
  type FactorPanelRow,
  type FactorValidationOptions,
  type FactorValidationReport,
  type SelectedFactor,
} from './factorAnalytics.js';

export interface FactorOptimizationResult {
  /** 入选因子的归一化权重表（Σ = 1），可直接用于 compositeZ */
  weights: Record<string, number>;
  /** 入选因子明细（含 IC / IR / 权重） */
  selected: SelectedFactor[];
  /** 完整验证报告（方向准确率、RMSE、逐因子 IC/IR） */
  report: FactorValidationReport;
}

/**
 * 因子权重最优化（Grinold & Kahn 最优组合）。
 * 在样本面板上：
 *   1. validateFactorModel 计算逐因子 IC/IR 并筛出最优因子集；
 *   2. 抽取「入选因子 → 归一化权重」的映射表，供 compositeZ 直接使用；
 *   3. 一并返回完整验证报告（方向准确率 / RMSE、缺失丢弃数），作为权重可信度的量化证据。
 * 面板样本 < 3 时 validateFactorModel 返回空报告，weights 随之为空表（调用方需自行兜底）。
 */
export function optimizeFactorWeights(
  panel: FactorPanelRow[],
  opts: FactorValidationOptions = {},
): FactorOptimizationResult {
  const report = validateFactorModel(panel, opts);
  const selected = report.perFactor.filter((f) => f.selected);
  const weights: Record<string, number> = {};
  for (const f of selected) weights[f.name] = f.weight;
  return { weights, selected, report };
}
