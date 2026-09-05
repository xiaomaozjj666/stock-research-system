import { describe, it, expect } from 'vitest';
import type { OHLCVData } from '../types.js';
import {
  buildEventObservations,
  buybackSignalEvents,
  dividendSignalEvents,
  unlockSignalEvents,
} from '../eventPanels.js';

/**
 * 公司事件面板单测：窗口映射（含事件前窗口）、后写覆盖、远期收益完整性、
 * 三类事件的信号方向与值语义（股息率/回购为正、解禁为负）。
 */

/** n 根日频 K 线：收盘价确定性递增（×1.001），升序日期 */
function genBars(n: number, start = '2024-01-01'): OHLCVData[] {
  const out: OHLCVData[] = [];
  let close = 100;
  const base = new Date(`${start}T00:00:00Z`).getTime();
  for (let i = 0; i < n; i++) {
    close = Math.round(close * 1.001 * 100) / 100;
    out.push({
      date: new Date(base + i * 86_400_000).toISOString().slice(0, 10),
      open: close,
      close,
      high: close,
      low: close,
      volume: 1000,
    });
  }
  return out;
}

describe('buildEventObservations — 窗口与观测', () => {
  const bars = genBars(40);

  it('事件日（含）起 windowDays 个交易日持有信号，逐日带全部持有期收益', () => {
    const events = [{ eventDate: bars[5].date, value: 2.5 }];
    const obs = buildEventObservations({
      code: '600519',
      events,
      bars,
      horizons: [5],
      windowDays: 10,
    });
    // 窗口 [5, min(5+10, 40-5=35)) → 10 个观测
    expect(obs).toHaveLength(10);
    expect(obs[0].date).toBe(bars[5].date);
    expect(obs[9].date).toBe(bars[14].date);
    expect(obs[0].returns[5]).toBeCloseTo(bars[10].close / bars[5].close - 1, 10);
    // 信号值逐日恒定
    expect(new Set(obs.map((o) => o.value))).toEqual(new Set([2.5]));
    // 全部属于同一 symbol
    expect(new Set(obs.map((o) => o.symbol))).toEqual(new Set(['600519']));
  });

  it('负偏移（事件前窗口）：解禁日历提前公开，事件前即持有信号', () => {
    const obs = buildEventObservations({
      code: '600519',
      events: [{ eventDate: bars[5].date, value: -4 }],
      bars,
      horizons: [3],
      startOffsetDays: -2,
      windowDays: 6,
    });
    // start = max(0, 5-2) = 3，end = min(3+6, 40-3=37) = 9 → 6 个观测
    expect(obs).toHaveLength(6);
    expect(obs[0].date).toBe(bars[3].date); // 事件前两个交易日开始
    expect(obs[obs.length - 1].date).toBe(bars[8].date);
  });

  it('同窗重叠：按事件时间升序后写覆盖（新事件覆盖旧信号）', () => {
    const events = [
      { eventDate: bars[2].date, value: 1 },
      { eventDate: bars[4].date, value: 2 },
    ];
    const obs = buildEventObservations({
      code: '600519',
      events,
      bars,
      horizons: [1],
      windowDays: 4,
    });
    // A: [2,6) 值 1；B: [4,8) 值 2 → 4,5 被覆盖；并集 2..7 共 6 天
    expect(obs).toHaveLength(6);
    const byDate = new Map(obs.map((o) => [o.date, o.value]));
    expect(byDate.get(bars[2].date)).toBe(1);
    expect(byDate.get(bars[3].date)).toBe(1);
    expect(byDate.get(bars[4].date)).toBe(2);
    expect(byDate.get(bars[5].date)).toBe(2);
    expect(byDate.get(bars[7].date)).toBe(2);
  });

  it('事件日在 K 线区间之后 → 无观测；NaN 值事件跳过', () => {
    expect(
      buildEventObservations({
        code: '600519',
        events: [{ eventDate: '2030-01-01', value: 1 }],
        bars,
        horizons: [5],
      }),
    ).toEqual([]);
    expect(
      buildEventObservations({
        code: '600519',
        events: [{ eventDate: bars[0].date, value: Number.NaN }],
        bars,
        horizons: [5],
      }),
    ).toEqual([]);
  });

  it('bars 不足 maxHorizon → 无观测（与截面面板同口径）', () => {
    expect(
      buildEventObservations({
        code: '600519',
        events: [{ eventDate: bars[0].date, value: 1 }],
        bars: bars.slice(0, 5),
        horizons: [21],
      }),
    ).toEqual([]);
  });
});

describe('dividendSignalEvents — 股息率信号（正方向）', () => {
  const bars = genBars(40);

  it('优先用东财股息率字段；缺失时用每10股股利/公告前收盘折算', () => {
    const obs = dividendSignalEvents(
      [
        { announceDate: bars[5].date, exDate: null, per10Cash: 48, dividendYieldPct: 3.2 },
        { announceDate: bars[10].date, exDate: null, per10Cash: 50, dividendYieldPct: null },
      ],
      bars,
    );
    expect(obs).toHaveLength(2);
    expect(obs[0]).toEqual({ eventDate: bars[5].date, value: 3.2 });
    // 每10股50元 = 每股5元；5 / bars[10].close × 100，保留 2 位小数（0.01% 精度）
    const expectedYield = Math.round((50 / 10 / bars[10].close) * 100 * 100) / 100;
    expect(obs[1].value).toBe(expectedYield);
  });

  it('零股利/零股息率的「不分配」行跳过；只有除权日也接受', () => {
    const obs = dividendSignalEvents(
      [
        { announceDate: bars[2].date, exDate: null, per10Cash: 0, dividendYieldPct: 0 },
        { announceDate: null, exDate: bars[8].date, per10Cash: 20, dividendYieldPct: null },
      ],
      bars,
    );
    expect(obs).toHaveLength(1);
    expect(obs[0].eventDate).toBe(bars[8].date);
  });
});

describe('buybackSignalEvents — 回购力度信号（正方向）', () => {
  it('信号 = 占总股本比例上限；比例缺失/非正跳过', () => {
    const obs = buybackSignalEvents([
      {
        announceDate: '2024-03-01',
        startDate: null,
        ratioHighPct: 2.5,
        amountHighYuan: 5e8,
        progress: '实施中',
      },
      {
        announceDate: '2024-05-01',
        startDate: null,
        ratioHighPct: null,
        amountHighYuan: 3e8,
        progress: '完成实施',
      },
      {
        announceDate: '2024-06-01',
        startDate: null,
        ratioHighPct: 0,
        amountHighYuan: 1e8,
        progress: '完成实施',
      },
    ]);
    expect(obs).toEqual([{ eventDate: '2024-03-01', value: 2.5 }]);
  });
});

describe('unlockSignalEvents — 解禁压力信号（负方向）', () => {
  it('信号 = 负的占解禁前流通市值比例（%）：占比越大假设收益越差', () => {
    const obs = unlockSignalEvents([
      { freeDate: '2024-08-10', ratioOfFloatPct: 100, shares: 1e8, marketCapYuan: 1.2e9 },
      { freeDate: '2025-08-10', ratioOfFloatPct: 2.05, shares: 2e6, marketCapYuan: 3e7 },
      { freeDate: null, ratioOfFloatPct: 5, shares: null, marketCapYuan: null },
    ]);
    expect(obs).toEqual([
      { eventDate: '2024-08-10', value: -100 },
      { eventDate: '2025-08-10', value: -2.05 },
    ]);
  });
});
