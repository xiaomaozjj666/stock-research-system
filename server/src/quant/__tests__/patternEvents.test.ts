import { describe, it, expect } from 'vitest';
import {
  detectPatternEvents,
  turtleBreakoutEvents,
  maVolumeBreakoutEvents,
  limitUpEvents,
} from '../patternEvents.js';
import type { OHLCVData } from '../types.js';

/** 程序化造 K 线：价格/成交量由调用方逐根给定 */
function makeBars(rows: { close: number; open?: number; volume?: number }[]): OHLCVData[] {
  return rows.map((r, i) => {
    const open = r.open ?? (i === 0 ? r.close : rows[i - 1].close);
    return {
      date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
      open,
      high: Math.max(open, r.close),
      low: Math.min(open, r.close),
      close: r.close,
      volume: r.volume ?? 1000,
    };
  });
}

describe('turtleBreakoutEvents — 海龟突破', () => {
  it('横盘序列无事件', () => {
    const bars = makeBars(Array.from({ length: 40 }, () => ({ close: 10, open: 10 })));
    expect(turtleBreakoutEvents(bars)).toHaveLength(0);
  });

  it('放量阳线突破 20 日新高 → 事件触发，value = 突破幅度', () => {
    const rows = Array.from({ length: 30 }, () => ({ close: 10, open: 10, volume: 1000 }));
    rows.push({ close: 11, open: 10.2, volume: 2000 }); // 突破日：新高 + 阳线 + 2× 放量
    const events = turtleBreakoutEvents(makeBars(rows));
    expect(events).toHaveLength(1);
    expect(events[0].value).toBeCloseTo(0.1, 6);
  });

  it('缩量新高不算（防假突破的量能过滤）', () => {
    const rows = Array.from({ length: 30 }, () => ({ close: 10, open: 10, volume: 1000 }));
    rows.push({ close: 11, open: 10.2, volume: 1000 }); // 新高 + 阳线但无放量
    expect(turtleBreakoutEvents(makeBars(rows))).toHaveLength(0);
  });

  it('放量新高但收阴线不算（防上影线诱多）', () => {
    const rows = Array.from({ length: 30 }, () => ({ close: 10, open: 10, volume: 1000 }));
    rows.push({ close: 11, open: 11.5, volume: 2000 }); // 新高但阴线
    expect(turtleBreakoutEvents(makeBars(rows))).toHaveLength(0);
  });
});

describe('maVolumeBreakoutEvents — 均线上穿放量', () => {
  it('阴跌后放量阳线上穿 MA20 → 事件触发', () => {
    const rows: { close: number; open?: number; volume?: number }[] = [];
    // 30 根横盘 10 元（建立 MA20）
    for (let i = 0; i < 30; i++) rows.push({ close: 10, open: 10, volume: 1000 });
    // 跌到 9（收盘 < MA20）
    rows.push({ close: 9, open: 10, volume: 1000 });
    rows.push({ close: 9, open: 9, volume: 1000 });
    // 放量长阳收回 10.5（自下而上穿越 MA20）
    rows.push({ close: 10.5, open: 9, volume: 3000 });
    const events = maVolumeBreakoutEvents(makeBars(rows));
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.at(-1)!.value).toBeGreaterThan(0);
  });

  it('一直在 MA20 上方运行 → 无上穿事件', () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({
      close: 10 + i * 0.01,
      open: 10 + i * 0.01,
      volume: 1000,
    }));
    expect(maVolumeBreakoutEvents(makeBars(rows))).toHaveLength(0);
  });
});

describe('limitUpEvents — 涨停', () => {
  it('涨幅 ≥ 9.5% 记为事件（value=实际涨幅，供截面变异）', () => {
    const bars = makeBars([
      { close: 10 },
      { close: 11 }, // +10%
      { close: 11 },
      { close: 12.1 }, // +10%
      { close: 12 },
    ]);
    const events = limitUpEvents(bars);
    expect(events).toHaveLength(2);
    // 信号是实际涨幅而非常数：常数会让同日截面秩全并列、Spearman 分母为 0，IC 恒 0
    expect(events[0].value).toBeCloseTo(0.1, 4);
    expect(events[1].value).toBeCloseTo(0.1, 4);
  });

  it('涨幅越大信号越强（10% vs 19% 截面可区分）', () => {
    const bars = makeBars([
      { close: 10 },
      { close: 10.96 }, // +9.6%
      { close: 10.96 },
      { close: 13.04 }, // +19%
    ]);
    const events = limitUpEvents(bars);
    expect(events).toHaveLength(2);
    expect(events[1].value).toBeGreaterThan(events[0].value);
  });

  it('涨幅 5% 不算涨停', () => {
    const bars = makeBars([{ close: 10 }, { close: 10.5 }]);
    expect(limitUpEvents(bars)).toHaveLength(0);
  });
});

describe('detectPatternEvents — 分派与组合', () => {
  it('三个形态名均可分派且返回数组', () => {
    const bars = makeBars(Array.from({ length: 40 }, () => ({ close: 10, open: 10 })));
    for (const name of ['pat_turtle_breakout', 'pat_ma_volume_breakout', 'pat_limit_up'] as const) {
      expect(Array.isArray(detectPatternEvents(name, bars))).toBe(true);
    }
  });
});
