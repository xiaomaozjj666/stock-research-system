/**
 * 技术形态事件族（借鉴 Sequoia-X 的形态选股思路）
 * ------------------------------------------------------------------
 * 形态突破本质是「事件日」。把形态触发日当作事件，走与分红/回购/解禁同一套
 * buildEventObservations → 截面 IC / 分层单调 / OOS 检验：民间「胜率约 50%」
 * 的说法从此变成可测量的统计，而不是感觉。
 *
 * 全部只依赖 OHLCV（零额外网络调用）。方向约定与事件族一致：value 越大代表
 * 假设越正面；真实方向由数据判定——A 股形态胜率可能为负，这正是要测量的东西。
 *
 * 口径说明：涨停判定用 ±9.5% 近似（覆盖主板 10% 涨跌幅），20cm 品种的 9.5%
 * 不算涨停——这是有意的保守口径，避免把普通大涨误判为涨停事件。
 */
import type { OHLCVData } from './types.js';
import type { StockEvent } from './eventPanels.js';

export type PatternName = 'pat_turtle_breakout' | 'pat_ma_volume_breakout' | 'pat_limit_up';

export const PATTERN_NAMES: PatternName[] = [
  'pat_turtle_breakout',
  'pat_ma_volume_breakout',
  'pat_limit_up',
];

export const PATTERN_DESCRIPTIONS: Record<PatternName, string> = {
  pat_turtle_breakout: '海龟突破：收盘创 20 日新高 + 阳线 + 放量（1.5× 前 20 日均量）',
  pat_ma_volume_breakout: '均线上穿：收盘自下而上穿越 MA20 + 放量（1.5× 前 20 日均量）',
  pat_limit_up: '涨停（收盘涨幅 ≥ 9.5% 的保守近似口径）',
};

function mean(xs: number[]): number {
  if (xs.length === 0) return NaN;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** 前 win 根（不含当日）的均量；不足时返回 NaN */
function priorMeanVolume(bars: OHLCVData[], i: number, win: number): number {
  if (i < win) return NaN;
  const xs: number[] = [];
  for (let k = i - win; k < i; k++) xs.push(bars[k].volume);
  return mean(xs);
}

/**
 * 海龟突破：收盘创 20 日新高 + 阳线（close>open，防盘中冲高回落的假突破）
 * + 放量（当日量 ≥ 1.5× 前 20 日均量）。value = 突破幅度（close / 前 20 日最高收盘 - 1）。
 */
export function turtleBreakoutEvents(bars: OHLCVData[]): StockEvent[] {
  const events: StockEvent[] = [];
  const WIN = 20;
  for (let i = WIN; i < bars.length; i++) {
    const b = bars[i];
    let maxPrev = 0;
    for (let k = i - WIN; k < i; k++) maxPrev = Math.max(maxPrev, bars[k].close);
    const volMa = priorMeanVolume(bars, i, WIN);
    const isBull = b.close > b.open;
    const isVolume = Number.isFinite(volMa) && volMa > 0 && b.volume >= volMa * 1.5;
    if (!(b.close > maxPrev) || !isBull || !isVolume) continue;
    const value = maxPrev > 0 ? b.close / maxPrev - 1 : NaN;
    if (Number.isFinite(value)) events.push({ eventDate: b.date, value });
  }
  return events;
}

/**
 * 均线上穿放量：收盘自下而上穿越 MA20（昨收 ≤ 昨 MA20 且今收 > 今 MA20）
 * + 放量。value = 收盘相对 MA20 的乖离（close / MA20 - 1）。
 */
export function maVolumeBreakoutEvents(bars: OHLCVData[]): StockEvent[] {
  const events: StockEvent[] = [];
  const WIN = 20;
  let prevMa = NaN;
  for (let i = WIN; i < bars.length; i++) {
    const ma = mean(bars.slice(i - WIN + 1, i + 1).map((b) => b.close));
    const volMa = priorMeanVolume(bars, i, WIN);
    const crossed = Number.isFinite(prevMa) && bars[i - 1].close <= prevMa && bars[i].close > ma;
    const isVolume = Number.isFinite(volMa) && volMa > 0 && bars[i].volume >= volMa * 1.5;
    prevMa = ma;
    if (!crossed || !isVolume) continue;
    const value = ma > 0 ? bars[i].close / ma - 1 : NaN;
    if (Number.isFinite(value)) events.push({ eventDate: bars[i].date, value });
  }
  return events;
}

/**
 * 涨停（收盘涨幅 ≥ 9.5% 的保守近似）。value = 1（事件存在，正方向假设为
 * 短期溢价；真实方向由 IC 判定——A 股涨停后中期反转的文献证据不少）。
 */
export function limitUpEvents(bars: OHLCVData[]): StockEvent[] {
  const events: StockEvent[] = [];
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1].close;
    if (!(prev > 0)) continue;
    const chg = bars[i].close / prev - 1;
    if (chg >= 0.095) events.push({ eventDate: bars[i].date, value: 1 });
  }
  return events;
}

/** 按名称分派形态检测 */
export function detectPatternEvents(name: PatternName, bars: OHLCVData[]): StockEvent[] {
  switch (name) {
    case 'pat_turtle_breakout':
      return turtleBreakoutEvents(bars);
    case 'pat_ma_volume_breakout':
      return maVolumeBreakoutEvents(bars);
    case 'pat_limit_up':
      return limitUpEvents(bars);
  }
}
