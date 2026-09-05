import type { OHLCVData } from './types.js';
import type { FactorObservation } from './factorEvaluation.js';
import type { BuybackEventRow, DividendEventRow, UnlockEventRow } from './eventProvider.js';

/**
 * 公司事件因子面板（分红 / 回购 / 解禁）。
 *
 * 与 buildEarningsSurpriseObservations（PEAD）同构的窗口语义：
 * 事件列表（事件日 + 信号值）→ 事件窗口内的交易日持有该信号（每股每日恒定）
 * → 逐日产出带全部持有期远期收益的 FactorObservation；窗口外无观测（NaN 语义
 * 与「把过期信号洗成 0」有本质区别）。同窗重叠时按事件时间升序**后写覆盖**
 * （新事件覆盖旧信号）。
 *
 * 前视纪律：日期 t 的观测只带 t → t+h 的远期收益。解禁事件允许**事件前窗口**
 * ——解禁日历（FREE_DATE）是提前公开的既定安排，事件前信号无前视泄漏；
 * 分红/回购以公告日为事件日（公告前信号不可知），窗口只向未来展开。
 */

/** 单个事件的信号：事件日 + 已按经济方向定号的信号值 */
export interface StockEvent {
  /** 事件日（公告日/解禁日，YYYY-MM-DD） */
  eventDate: string;
  /**
   * 信号值。方向约定：值越大对未来收益的假设越正面——
   * 股息率（%）、回购占总股本比例（%）为正；解禁压力为**负值**（占比越大
   * 假设收益越差，取负后 IC 为正即支持假设）。
   */
  value: number;
}

export interface EventPanelOptions {
  code: string;
  events: StockEvent[];
  bars: OHLCVData[];
  /** 持有期（交易日）数组；每行须带全部持有期收益 */
  horizons: number[];
  /** 窗口起点相对事件日的交易日偏移（负 = 事件前）；默认 0 = 事件日（含）起 */
  startOffsetDays?: number;
  /** 窗口长度（交易日，自起点起）；默认 63 */
  windowDays?: number;
}

/**
 * 事件窗口 → 逐日观测。窗口末端截断到 bars.length - maxHorizon，
 * 保证每行全部持有期收益齐备（与 buildCrossSectionPanel 同口径）。
 */
export function buildEventObservations(opts: EventPanelOptions): FactorObservation[] {
  const { code, events, bars, horizons } = opts;
  const startOffset = opts.startOffsetDays ?? 0;
  const windowDays = opts.windowDays ?? 63;
  const maxHorizon = Math.max(...horizons);
  if (!(maxHorizon > 0) || bars.length <= maxHorizon || events.length === 0) return [];

  // 事件日 → bars 起点索引；后写覆盖（事件按升序遍历，越晚的事件覆盖越早的）
  const signalByDate = new Map<string, number>();
  for (const ev of events) {
    if (!Number.isFinite(ev.value)) continue;
    const t0 = bars.findIndex((b) => b.date >= ev.eventDate);
    if (t0 < 0) continue; // 事件日在 K 线区间之后：尚未开始，无观测
    const start = Math.max(0, t0 + startOffset);
    const end = Math.min(start + windowDays, bars.length - maxHorizon);
    for (let i = start; i < end; i++) {
      signalByDate.set(bars[i].date, ev.value);
    }
  }

  const obs: FactorObservation[] = [];
  for (const [date, value] of signalByDate) {
    const i = bars.findIndex((b) => b.date === date);
    const base = bars[i].close;
    if (!(base > 0)) continue;
    const returns: Record<number, number> = {};
    let complete = true;
    for (const h of horizons) {
      const ahead = bars[i + h]?.close;
      if (!(ahead > 0)) {
        complete = false;
        break;
      }
      returns[h] = ahead / base - 1;
    }
    if (!complete) continue;
    obs.push({ date, symbol: code, value, returns });
  }
  obs.sort((a, b) => a.date.localeCompare(b.date));
  return obs;
}

/** bars 升序时，取 date（含）之前最后一个有效收盘价——公告日通常为盘后，用当日收盘折算股息率 */
function closeOnOrBefore(bars: OHLCVData[], date: string): number | null {
  let best: number | null = null;
  for (const b of bars) {
    if (b.date > date) break;
    if (b.close > 0) best = b.close;
  }
  return best;
}

/**
 * 分红事件：信号 = 股息率（%）。
 * 东财详情口径的股息率常缺失，缺失时用「每10股股利 / 10 / 公告前收盘」折算；
 * 两者皆缺（不分配不转增已在 provider 层过滤）→ 跳过。
 */
export function dividendSignalEvents(rows: DividendEventRow[], bars: OHLCVData[]): StockEvent[] {
  const out: StockEvent[] = [];
  for (const r of rows) {
    const date = r.announceDate ?? r.exDate;
    if (!date) continue;
    if (r.dividendYieldPct !== null && r.dividendYieldPct > 0) {
      out.push({ eventDate: date, value: r.dividendYieldPct });
      continue;
    }
    if (r.per10Cash !== null && r.per10Cash > 0) {
      const base = closeOnOrBefore(bars, date);
      if (base === null) continue;
      out.push({
        eventDate: date,
        value: Math.round((r.per10Cash / 10 / base) * 100 * 100) / 100,
      });
    }
  }
  return out.sort((a, b) => a.eventDate.localeCompare(b.eventDate));
}

/**
 * 回购事件：信号 = 计划回购数量占公告前一日总股本比例上限（%，provider 已取正）。
 * 比例缺失时无信号（金额无法跨规模可比，不做半吊子折算）。
 */
export function buybackSignalEvents(rows: BuybackEventRow[]): StockEvent[] {
  return rows
    .filter((r) => r.announceDate !== null && r.ratioHighPct !== null && r.ratioHighPct > 0)
    .map((r) => ({ eventDate: r.announceDate as string, value: r.ratioHighPct as number }))
    .sort((a, b) => a.eventDate.localeCompare(b.eventDate));
}

/**
 * 解禁事件：信号 = **负的**解禁量占解禁前流通市值比例（%）。
 * 供给冲击假说：解禁占比越大、未来收益越差——取负后 IC 为正即支持假设，
 * 因子名（ev_unlock_overhang，解禁压力）与方向语义一致。
 * 窗口含事件前 20 个交易日（解禁日历提前公开，无前视）。
 */
export function unlockSignalEvents(rows: UnlockEventRow[]): StockEvent[] {
  return rows
    .filter((r) => r.freeDate !== null && r.ratioOfFloatPct !== null && r.ratioOfFloatPct > 0)
    .map((r) => ({
      eventDate: r.freeDate as string,
      value: -(r.ratioOfFloatPct as number),
    }))
    .sort((a, b) => a.eventDate.localeCompare(b.eventDate));
}

/** 解禁事件的窗口参数：事件前 20 日（含）到事件后 20 日 */
export const UNLOCK_START_OFFSET_DAYS = -20;
export const UNLOCK_WINDOW_DAYS = 41;
