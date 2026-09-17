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
 * 分数 / 评级好坏 → 状态语义色类名（**不是**涨跌方向）
 * ----------------------------------------------------------------------------
 * 「优秀 / 良好 / 一般 / 较差」是状态判定而不是数值方向：此前 DataQualityPanel 与
 * ReportSummary 用 --color-positive（红）表示高分，等于把「好成绩」画成「涨停」，
 * 与同页面的 .val-positive（红涨）语义直接冲突。
 * 这里改用与涨跌解耦的状态色板（--color-success / --accent / --color-warning /
 * --color-danger），类定义在 index.css；页面上的收益 / alpha 方向一律继续用 signCls()。
 */
export interface ScoreThresholds {
  /** >= excellent 为「优秀 / 高分」 */
  excellent: number;
  /** >= good 为「良好」 */
  good: number;
  /** >= fair 为「一般 / 需注意」；低于 fair 为「较差」 */
  fair: number;
}

/** 综合评分默认口径：80 优秀 / 60 良好 / 40 一般 */
export const DEFAULT_SCORE_THRESHOLDS: ScoreThresholds = { excellent: 80, good: 60, fair: 40 };

/**
 * 数据质量面板口径：只有三档（>=80 优秀 / >=60 良好 / 其余较差）。
 * fair 与 good 同值 = 不设「一般」档，语义见 scoreGrade 的注释。
 */
export const DATA_QUALITY_SCORE_THRESHOLDS: ScoreThresholds = { excellent: 80, good: 60, fair: 60 };

export type ScoreGrade = 'excellent' | 'good' | 'fair' | 'poor';

/** 分数 → 档位（非有限值一律算「较差」，避免 NaN 落进高分档） */
export function scoreGrade(
  score: number,
  thresholds: ScoreThresholds = DEFAULT_SCORE_THRESHOLDS,
): ScoreGrade {
  if (!Number.isFinite(score)) return 'poor';
  if (score >= thresholds.excellent) return 'excellent';
  if (score >= thresholds.good) return 'good';
  if (score >= thresholds.fair) return 'fair';
  return 'poor';
}

/** 分数文字的配色类名（状态语义，不是涨跌色） */
export function scoreCls(
  score: number,
  thresholds: ScoreThresholds = DEFAULT_SCORE_THRESHOLDS,
): string {
  return `score-${scoreGrade(score, thresholds)}`;
}

/** 分数进度条 / 色块的配色类名（与 scoreCls 同档，供 background 使用） */
export function scoreBarCls(
  score: number,
  thresholds: ScoreThresholds = DEFAULT_SCORE_THRESHOLDS,
): string {
  return `score-bar-${scoreGrade(score, thresholds)}`;
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
