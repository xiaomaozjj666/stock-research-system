/**
 * 涨跌 / 显著性着色口径（统一入口）
 * ============================================================================
 * 背景：A 股惯例是「红涨绿跌」（--color-positive 红 / --color-negative 绿），
 * 而量化面板之前把「统计显著性」色板（.sig-valid 绿 / .sig-inverted 琥珀）当成
 * 「赚 / 亏」用，于是 +12% 的正收益被渲染成绿色——与红涨绿跌正好相反，
 * 且与同页面其它模块（.val-positive / .val-negative、quant-metric-value）互相矛盾。
 *
 * 这里把两种语义彻底分开，调用方按「这个数字是什么」选函数：
 *   signCls(v)              → 数值方向（收益 / 涨跌 / alpha 方向）：正 = 红，负 = 绿
 *   significanceCls(kind)   → 统计显著性 / OOS 通过 / 是否采信：沿用既有 .sig-* 色板
 *
 * 注意：index.css 里 .sig-* 的颜色语义（绿 = 显著且方向符合预期、
 * 琥珀 = 显著但方向相反）本身是对的，本次只纠正「用法」，不改色值。
 */

/** 数值方向 → 涨跌色类名（可直接用在 td/span/b 上；纯配色，不带背景） */
export function signCls(
  v: number | null | undefined,
): 'val-positive' | 'val-negative' | 'val-neutral' {
  // null/undefined/NaN/0 一律视为中性：0 既不是涨也不是跌，
  // 用任一侧的颜色都会让读者误判方向（此前 >= 0 全部走红/绿，0 被算作涨）
  if (v == null || !Number.isFinite(v) || v === 0) return 'val-neutral';
  return v > 0 ? 'val-positive' : 'val-negative';
}

/** 显著性判定结果：通过（方向符合预期）/ 反向显著 / 不显著 */
export type SignificanceKind = 'valid' | 'inverted' | 'none';

/** 显著性 → 既有 .sig-* 色板类名（绿 / 琥珀 / 灰） */
export function significanceCls(kind: SignificanceKind): string {
  if (kind === 'valid') return 'sig-valid';
  if (kind === 'inverted') return 'sig-inverted';
  return 'sig-none';
}

/**
 * 图表取色：与 index.css :root 的设计令牌一一对应
 * ----------------------------------------------------------------------------
 * ECharts 画在 canvas 上，`fillStyle = 'var(--accent)'` 是无效值（canvas 解析不了
 * CSS 自定义属性，会静默退回黑色），所以图表侧只能取令牌的字面量。
 * 改主题色时两处需同步：index.css 的 :root 与这里。
 */
export const CHART_COLOR = {
  /** --accent */
  accent: '#4c8dff',
  /** --border-default（网格线 / 轴线 / tooltip 描边） */
  border: '#232b37',
  /** --text-primary（tooltip 正文） */
  textPrimary: '#e9edf3',
  /** --text-secondary（图例等次级文字） */
  textSecondary: '#9ba6b4',
  /** --text-muted（坐标轴刻度、对照曲线） */
  textMuted: '#7c8899',
  /** --bg-card 的半透明版本（tooltip 底：需压住下层曲线） */
  tooltipBg: 'rgba(20, 25, 32, 0.95)',
} as const;
