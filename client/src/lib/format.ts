/**
 * 数值展示的单一来源。
 *
 * 总市值此前在 4 个组件里各写一份，格式不一致（`1.6 万亿` / `1.60万亿` / `1.6万亿`），
 * 且只有一份挡住了 NaN/Infinity/负数。统一到这里，改口径只改一处。
 */

/** 总市值（亿元）→ 「亿 / 万亿」。缺失、非有限值（NaN/Infinity）、非正数一律显示「—」 */
export function formatMarketCap(cap?: number | null): string {
  if (cap == null || !Number.isFinite(cap) || cap <= 0) return '—';
  return cap >= 10000 ? `${(cap / 10000).toFixed(1)}万亿` : `${cap.toFixed(0)}亿`;
}
