/**
 * 可插拔交易成本模型（借鉴 backtrader CommInfoBase / qlib Exchange / gs-quant backtests 成本处理）
 *
 * 三份研究报告交叉印证的一致结论：
 * - backtrader CommInfoBase：佣金可带方向（印花税等税费只收卖出单边）；
 * - qlib Exchange：open/close 不对称费率 + minCost 兜底 + 二次方市场冲击成本，撮合统一返回成交价/成本；
 * - gs-quant SimulatedExecutionEngine：成本与撮合解耦，可插拔。
 *
 * 默认模型（DEFAULT_COST_MODEL 语义）保持引擎历史行为：佣金双边对称、无最低费用、无市场冲击。
 * A_SHARE_COST_MODEL 为 A 股真实规则：佣金万 2.5 双边 + 印花税万 5 仅卖出单边（2023-08-28 起）
 * + 单笔最低佣金 5 元 + 二次方市场冲击（qlib 推荐 impactCost=0.1）。
 */

export interface CostModel {
  /** 买入费率（佣金率），如 0.00025 = 万 2.5 */
  openRate: number;
  /** 卖出费率（佣金率 + 卖出方税费，如印花税），如 0.00075 = 万 7.5 */
  closeRate: number;
  /** 单笔最低费用（元），0 = 不设下限 */
  minCost: number;
  /** 滑点率（买入上滑 / 卖出下滑），0.001 = 0.1% */
  slippage: number;
  /**
   * 二次方市场冲击系数（qlib Exchange `impact_cost`，推荐 0.1）：
   * 冲击金额 = impactCost × (成交股数/当日成交量)² × 成交额——无量纲参与率越高冲击越大，
   * 且金额有上界 impactCost × 成交额；
   * 0 / 缺省 = 不模拟市场冲击。
   */
  impactCost?: number;
}

/** 默认模型：佣金双边对称（保持历史行为），无最低费用 */
export const DEFAULT_COST_MODEL: CostModel = {
  openRate: 0.0003, // 万三
  closeRate: 0.0003,
  minCost: 0,
  slippage: 0.001,
};

/**
 * A 股真实费率模型：
 * - 佣金万 2.5（0.025%）双边；
 * - 印花税万 5（0.05%）仅卖出单边（2023-08-28 起）→ closeRate = 0.00025 + 0.0005 = 0.00075；
 * - 单笔佣金最低 5 元；
 * - 二次方市场冲击系数 0.1（qlib Exchange 推荐值）。
 */
export const A_SHARE_COST_MODEL: CostModel = {
  openRate: 0.00025,
  closeRate: 0.00075,
  minCost: 5,
  slippage: 0.001,
  impactCost: 0.1,
};

/** 以默认模型为底，按需覆盖字段构造新模型 */
export function makeCostModel(overrides: Partial<CostModel>): CostModel {
  return { ...DEFAULT_COST_MODEL, ...overrides };
}

/**
 * 二次方市场冲击成本（qlib Exchange impact_cost 语义，按无量纲参与率计算）：
 * 冲击金额 = impactCost × (tradeShares / volumeShares)² × tradeVal。
 * 参与率为「股/股」同单位比值（qlib 口径），参与率 100% 时冲击封顶 impactCost × 成交额。
 * 注意：旧公式 impactCost × (成交额/成交量)² 混用「元/手」量纲——既不是比例也不是金额，
 * 低流动性个股（如 100 万成交额 vs 1000 手成交量）会凭空算出 10 万元冲击吃掉 10% 本金。
 * 系数缺省/≤0 或任一输入无效时返回 0。
 */
export function marketImpactCost(
  model: CostModel,
  tradeVal: number,
  volumeShares: number,
  tradeShares: number,
): number {
  const k = model.impactCost ?? 0;
  if (k <= 0 || !(volumeShares > 0) || tradeVal <= 0 || !(tradeShares > 0)) return 0;
  const participation = Math.min(1, tradeShares / volumeShares);
  return k * participation * participation * tradeVal;
}

/** 买入成本：总支出 = 成交额 + 费用（费用 = max(成交额×openRate, minCost)） */
export function buyCost(
  model: CostModel,
  shares: number,
  price: number,
): { total: number; fee: number } {
  const gross = shares * price;
  const fee = Math.max(gross * model.openRate, model.minCost);
  return { total: gross + fee, fee };
}

/** 卖出所得：净收入 = 成交额 − 费用（费用 = max(成交额×closeRate, minCost)） */
export function sellProceeds(
  model: CostModel,
  shares: number,
  price: number,
): { proceeds: number; fee: number } {
  const gross = shares * price;
  const fee = Math.max(gross * model.closeRate, model.minCost);
  return { proceeds: gross - fee, fee };
}
