import { describe, it, expect } from 'vitest';
import {
  MAX_DATE_RANGE_SPAN_DAYS,
  formatLocalIsoDate,
  isValidIsoDate,
  resolveDateRange,
  resolveDateRangeFromRaw,
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

  it('只传 endDate → start 由 end 反推（契约：start = end - defaultSpanDays）', () => {
    // 回归：旧实现用 now 反推 start，导致「只传 endDate」得到晚于 end 的 start，
    // 抛出自相矛盾的 400（调用方根本没传 startDate）
    const r = resolveDateRange(undefined, '2024-01-01', {
      defaultSpanDays: 30,
      now: Date.parse('2026-01-01T02:00:00Z'),
    });
    expect(r.end).toBe('2024-01-01');
    expect(r.start).toBe('2023-12-02');
  });

  it('只传 endDate 且区间超上限 → 按真实区间拒绝（错误信息指向跨度而非 startDate 缺省）', () => {
    expect(() => resolveDateRange(undefined, '2024-01-01', { defaultSpanDays: 4000 })).toThrow(
      /跨度|startDate/,
    );
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

describe('resolveDateRangeFromRaw — 原始入参严格解析（缺省→默认，非法→400）', () => {
  const spec = { defaultSpanDays: 30, now: Date.parse('2026-01-31T02:00:00Z') };

  it('未传/空串/纯空白 → 默认区间（表单空值不误报）', () => {
    for (const raw of [undefined, null, '', '   ']) {
      const r = resolveDateRangeFromRaw(raw, raw, spec);
      expect(r.end).toBe('2026-01-31');
      expect(r.start).toBe('2026-01-01');
    }
  });

  it('重复 query 参数（数组形态）→ DateRangeParamError（不静默取第一个/当未传）', () => {
    expect(() => resolveDateRangeFromRaw(['2024-01-01', '2024-02-01'], undefined, spec)).toThrow(
      DateRangeParamError,
    );
    expect(() => resolveDateRangeFromRaw(undefined, ['2024-01-01'], spec)).toThrow(/只能传一个值/);
  });

  it('非字符串（数字/对象）→ DateRangeParamError', () => {
    expect(() => resolveDateRangeFromRaw(20240101, undefined, spec)).toThrow(
      /需为 YYYY-MM-DD 字符串/,
    );
    expect(() => resolveDateRangeFromRaw({ d: '2024-01-01' }, undefined, spec)).toThrow(/字符串/);
  });

  it('非法日期字符串 → DateRangeParamError（不静默回落默认值）', () => {
    expect(() => resolveDateRangeFromRaw('2024/01/02', undefined, spec)).toThrow(/真实日期/);
    expect(() => resolveDateRangeFromRaw('2024-02-30', undefined, spec)).toThrow(/真实日期/);
  });
});
