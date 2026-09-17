import { describe, it, expect } from 'vitest';
import {
  MAX_DATE_RANGE_SPAN_DAYS,
  formatLocalIsoDate,
  isValidIsoDate,
  resolveDateRange,
  DateRangeParamError,
} from '../dateRange.js';

/**
 * 取数区间校验（#2）：格式 / 真实日历日 / 顺序 / 跨度上限。
 * 这些规则此前只存在于量化初筛（screener.ts），因子测量类路由（composite /
 * expression）只做 String() 强转甚至完全忽略入参——非法或超长跨度会原样落到
 * 「每只股票按区间拉一遍 K 线」上，把单次请求的成本放大几个量级。
 */
describe('isValidIsoDate', () => {
  it.each(['2024-01-01', '2024-02-29', '1999-12-31'])('接受真实日历日 %s', (v) => {
    expect(isValidIsoDate(v)).toBe(true);
  });

  it.each([
    ['2024-1-1', '非零填充'],
    ['2024/01/01', '分隔符错误'],
    ['2024-02-30', '不存在的日历日'],
    ['2023-02-29', '非闰年 2 月 29 日'],
    ['2024-13-01', '月份越界'],
    ['2024-00-10', '月份为 0'],
    ['2024-01-32', '日越界'],
    ['', '空串'],
    ['2024-01-01T00:00:00Z', '带时间'],
  ])('拒绝 %s（%s）', (v) => {
    expect(isValidIsoDate(v)).toBe(false);
  });
});

describe('resolveDateRange', () => {
  it('未传时用各调用方给的默认窗口（不改变正常路径）', () => {
    const now = Date.parse('2026-05-20T10:00:00Z');
    const r = resolveDateRange(undefined, undefined, { now, defaultSpanDays: 730 });
    expect(r.end).toBe('2026-05-20');
    // 730 天前 = 2024-05-20（含 2024 闰日）；断言用差值而非硬编码，避免闰年口径脆断
    const spanDays = Math.round((Date.parse(r.end) - Date.parse(r.start)) / 86_400_000);
    expect(spanDays).toBe(730);
  });

  it('默认窗口按本地日历日取整（时区偏移下不得退到前一天）', () => {
    // 不硬编码期望值：本用例是在断言"用的是本地日历日、不是 UTC 日"，
    // 硬编码 '2026-01-01' 只在 UTC+8 成立，CI（UTC）会得到 2025-12-31。
    // 这里按进程本地时区算出期望，两种时区下都检验同一件事。
    const now = Date.parse('2025-12-31T16:30:00Z');
    const localDay = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const expectEnd = localDay(new Date(now));
    expect(formatLocalIsoDate(new Date(now))).toBe(expectEnd);

    const r = resolveDateRange(undefined, undefined, { now, defaultSpanDays: 1 });
    expect(r.end).toBe(expectEnd);
    // 起止相差恰好 1 天（跨月/跨年都不影响）
    expect(Math.round((Date.parse(r.end) - Date.parse(r.start)) / 86_400_000)).toBe(1);
  });

  it('显式区间原样返回（不静默改写调用方给的区间）', () => {
    expect(resolveDateRange('2024-01-01', '2024-06-30')).toEqual({
      start: '2024-01-01',
      end: '2024-06-30',
    });
  });

  it('只传 startDate → end 取默认（今天）', () => {
    const now = Date.parse('2026-05-20T10:00:00Z');
    const r = resolveDateRange('2026-05-01', undefined, { now, defaultSpanDays: 730 });
    expect(r).toEqual({ start: '2026-05-01', end: '2026-05-20' });
  });

  it.each([
    ['非法 startDate', '2024-02-30', '2024-03-01', /startDate/],
    ['非法 endDate', '2024-01-01', '2024-13-01', /endDate/],
    ['倒置区间', '2024-06-30', '2024-01-01', /不得晚于/],
  ])('%s → 抛 DateRangeParamError', (_name, start, end, pattern) => {
    expect(() => resolveDateRange(start, end)).toThrow(DateRangeParamError);
    expect(() => resolveDateRange(start, end)).toThrow(pattern);
  });

  it('跨度恰为上限 → 通过；超过上限 1 天 → 拒绝（复用初筛的 10.5 年上限）', () => {
    const span = MAX_DATE_RANGE_SPAN_DAYS;
    const endMs = Date.parse('2026-01-01T00:00:00Z');
    const startAt = (days: number) =>
      new Date(endMs - days * 86_400_000).toISOString().slice(0, 10);
    expect(() => resolveDateRange(startAt(span), '2026-01-01')).not.toThrow();
    expect(() => resolveDateRange(startAt(span + 1), '2026-01-01')).toThrow(/区间过长/);
  });
});
