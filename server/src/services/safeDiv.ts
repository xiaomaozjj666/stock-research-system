/**
 * 安全除法：分母为 0、NaN 或 Infinity 时返回 fallback
 */
export function safeDiv(numerator: number, denominator: number, fallback = 0): number {
  if (!denominator || !isFinite(denominator)) return fallback;
  return numerator / denominator;
}
