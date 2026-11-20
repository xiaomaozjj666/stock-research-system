import { DomainError } from './domainError.js';
/**
 * 取数区间（startDate / endDate）校验
 * ----------------------------------------------------------------------------
 * 背景（审计 #2）：量化侧的「区间」入参此前只有全市场初筛做了校验，
 * 因子测量类路由（/factor/composite、/factor/composite/batch、/factor/expression、
 * /factor/expression/batch）只做 `String()` 强转（expression 两条甚至完全忽略入参），
 * 非法日期 / 倒置区间 / 十年以上的超长跨度会原样落到
 * 「每只股票按同一区间拉一遍 K 线」上——截面宽度 × 区间长度直接乘出上游成本，
 * 并把 dataProvider 的模拟降级路径拖进几万次同步迭代。
 *
 * 本模块把 screener.ts 里已有的三条规则（真实日历日 / 顺序 / 跨度上限）抽成
 * 单一实现，供初筛与因子路由共用，避免两处口径漂移：
 *   1. 必须形如 `YYYY-MM-DD` 且是**真实存在的日历日**；
 *   2. start ≤ end；
 *   3. 跨度 ≤ maxSpanDays。
 * 任一不满足即抛 DateRangeParamError（message 为可直接展示的中文说明），
 * 调用方据此回 400——**不静默回落默认值**，否则调用方会以为跑的是自己给的区间。
 */

/**
 * 区间跨度硬上限（自然日）：约 10.5 年。
 *
 * 与初筛的 MAX_SCREENER_SPAN_DAYS 取同一数值与同一理由：每只股票的 K 线都要按此
 * 区间拉取/合成，跨度直接决定单次请求的成本。10 年足够覆盖 250 日 RPS、全部形态
 * 窗口与常规因子回看期（默认区间仅 400~730 天），再长属于误传或滥用。
 */
export const MAX_DATE_RANGE_SPAN_DAYS = 3840;

/** 初筛默认区间长度（自然日）：约 400 天（与原 screener 默认一致） */
export const DEFAULT_SCREENER_WINDOW_DAYS = 400;

/** 因子测量路由默认区间长度（自然日）：约 2 年（与原 composite 默认一致） */
export const DEFAULT_FACTOR_WINDOW_DAYS = 730;

/** 区间入参校验失败（路由据此回 400 而不是 500）：message 为可直接展示的中文说明 */
export class DateRangeParamError extends DomainError {
  constructor(message: string) {
    super(message, 400, 'DATE_RANGE_PARAM');
    this.name = 'DateRangeParamError';
  }
}

/** 日期形态与真实性校验：`YYYY-MM-DD` 且必须是真实存在的日历日（拒 2026-02-30 / 2026-13-01） */
export function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  // Invalid Date 或「被 Date 归一化到别的日子」（如 02-30 → 03-02）都视为非法
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * 本地日历日的 `YYYY-MM-DD`。
 *
 * 刻意不用 `toISOString().slice(0,10)`：那是 UTC 口径，在东八区凌晨（00:00-08:00）
 * 会把「今天」算成昨天，于是默认区间的右端点与用户看到的当天不一致。
 * 容错：非法 Date 回退到 UTC 口径，保证返回值始终是合法日期串。
 */
export function formatLocalIsoDate(d: Date): string {
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 纯日期加减（UTC 数学，与本地时区无关）：用于由 end 反推默认 start */
export function shiftIsoDate(iso: string, days: number): string {
  const base = Date.parse(`${iso}T00:00:00Z`);
  return new Date(base + days * 86_400_000).toISOString().slice(0, 10);
}

export interface ResolveDateRangeSpec {
  /** 默认区间长度（自然日）：未传起始日时，start = end - defaultSpanDays */
  defaultSpanDays: number;
  /** 跨度上限（自然日），默认 MAX_DATE_RANGE_SPAN_DAYS */
  maxSpanDays?: number;
  /** 当前时刻（毫秒），默认 Date.now()——测试可注入以获得确定性 */
  now?: number;
}

/**
 * 校验并解析取数区间。
 *
 * 语义（与初筛的 parseScreenerDateRange 一致）：
 *   - 未传 end → 今天；未传 start → end - defaultSpanDays；
 *   - 传了就必须合法，否则抛 DateRangeParamError（不静默回落默认值）；
 *   - 返回值即调用方应当使用的区间，原样透传，不做二次改写。
 */
/**
 * 从 **原始请求入参**（undefined/null/字符串/数组/其它）严格解析日期区间。
 *
 * 口径（与 Stripe / GitHub / Google AIP-193 的 API 约定一致）：
 *   - 缺省（undefined / null / 空串 / 纯空白）→ 由 resolveDateRange 给默认值；
 *   - 形态非法（重复 query 得到的数组、数字、对象）→ 抛 DateRangeParamError（400）；
 *   - 存在的字符串必须能解析成真实日期，否则 400——**绝不静默回落默认值**：
 *     静默替换会让结果被归因到调用方并未请求的时间窗，且隐藏调用方的 bug。
 */
export function resolveDateRangeFromRaw(
  startDateRaw: unknown,
  endDateRaw: unknown,
  spec?: ResolveDateRangeSpec,
): { start: string; end: string } {
  const pick = (raw: unknown, field: 'startDate' | 'endDate'): string | undefined => {
    if (raw === undefined || raw === null) return undefined;
    if (Array.isArray(raw)) {
      throw new DateRangeParamError(`${field} 只能传一个值（收到重复参数）`);
    }
    if (typeof raw !== 'string') {
      throw new DateRangeParamError(`${field} 需为 YYYY-MM-DD 字符串（收到 ${typeof raw}）`);
    }
    const trimmed = raw.trim();
    return trimmed === '' ? undefined : trimmed;
  };
  return resolveDateRange(pick(startDateRaw, 'startDate'), pick(endDateRaw, 'endDate'), spec);
}

export function resolveDateRange(
  startDate: string | undefined,
  endDate: string | undefined,
  spec: ResolveDateRangeSpec = { defaultSpanDays: DEFAULT_FACTOR_WINDOW_DAYS },
): { start: string; end: string } {
  const now = spec.now ?? Date.now();
  const maxSpanDays = spec.maxSpanDays ?? MAX_DATE_RANGE_SPAN_DAYS;
  const end = endDate ?? formatLocalIsoDate(new Date(now));

  // 先校验 end：默认 start 必须由**end**反推（契约：start = end - defaultSpanDays）。
  // 此前用 now 反推，导致「只传 endDate」的请求得到一个晚于 end 的 start，
  // 触发自相矛盾的 400（调用方根本没传 startDate）。
  if (!isValidIsoDate(end)) {
    throw new DateRangeParamError(`endDate 需为 YYYY-MM-DD 的真实日期（当前：${end}）`);
  }
  const start = startDate ?? shiftIsoDate(end, -spec.defaultSpanDays);
  if (!isValidIsoDate(start)) {
    throw new DateRangeParamError(`startDate 需为 YYYY-MM-DD 的真实日期（当前：${start}）`);
  }
  const startMs = Date.parse(`${start}T00:00:00Z`);
  const endMs = Date.parse(`${end}T00:00:00Z`);
  if (startMs > endMs) {
    throw new DateRangeParamError(`startDate（${start}）不得晚于 endDate（${end}）`);
  }
  const spanDays = Math.round((endMs - startMs) / 86_400_000);
  if (spanDays > maxSpanDays) {
    throw new DateRangeParamError(
      `扫描区间过长（${spanDays} 天 > ${maxSpanDays} 天），请缩小 startDate/endDate 跨度`,
    );
  }
  return { start, end };
}
