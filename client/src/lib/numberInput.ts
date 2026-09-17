/**
 * 数字输入的取值边界（与量化路由的服务端校验保持一致）
 * ============================================================================
 * 背景：`topN` / 组合回测参数此前只靠 HTML 的 min/max 限制 spinner，
 * 手输 0、9999、小数都会原样下发，再由服务端回一条 400 —— 用户白等一次往返，
 * 看到的还是"当前：9999"这种需要自己回推的提示。
 *
 * 边界必须与服务端一致，否则会把 400 变成"静默换成另一个数"：
 *   - topN：server/src/routes/quant.ts resolveUniverse（3 ~ crossSectionMaxCodes，默认 300）
 *   - 组合回测：同文件 parsePortfolioOptions（holdDays 1-250 / topN 1-50 / costBps 0-500）
 *
 * 钳制放在**提交时**而不是 onChange：用户输入「300」时先打到「3」就被改写会很难用。
 */

/** 宇宙宽度（板块成分股取前 N 只） */
export const UNIVERSE_TOP_N = { min: 3, max: 300, dflt: 10 } as const;
/** 组合回测调仓周期（交易日） */
export const PORTFOLIO_HOLD_DAYS = { min: 1, max: 250, dflt: 21 } as const;
/** 组合回测持仓只数 */
export const PORTFOLIO_TOP_N = { min: 1, max: 50, dflt: 5 } as const;
/** 组合回测单边成本（bps） */
export const PORTFOLIO_COST_BPS = { min: 0, max: 500, dflt: 30 } as const;

export interface IntBounds {
  min: number;
  max: number;
  dflt: number;
}

/**
 * 取整并钳到 [min, max]。非有限值（空输入 → NaN）回落 dflt，再取整。
 * 空输入不报错而用默认值：表单里的空数字框语义就是"用默认"。
 */
export function clampInt(v: number, { min, max, dflt }: IntBounds): number {
  const n = Math.floor(Number.isFinite(v) ? v : dflt);
  return Math.min(max, Math.max(min, n));
}
