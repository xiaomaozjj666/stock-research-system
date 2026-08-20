import { describe, it, expect } from 'vitest';
import {
  aggregateCandles,
  computeEMA,
  computeMACD,
  computeMA,
  type Candle,
} from '../trendMath';

describe('computeMA', () => {
  it('前 n-1 个位置为 null，之后为窗口均值', () => {
    const s = [1, 2, 3, 4, 5];
    const ma = computeMA(s, 3);
    expect(ma[0]).toBeNull();
    expect(ma[1]).toBeNull();
    expect(ma[2]).toBe(2); // (1+2+3)/3
    expect(ma[3]).toBe(3); // (2+3+4)/3
    expect(ma[4]).toBe(4); // (3+4+5)/3
  });

  it('空序列返回空数组', () => {
    expect(computeMA([], 5)).toEqual([]);
  });
});

describe('computeEMA', () => {
  it('长度与输入一致', () => {
    const s = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const ema = computeEMA(s, 12);
    expect(ema).toHaveLength(s.length);
  });

  it('常数序列的 EMA 等于该常数', () => {
    const s = [5, 5, 5, 5, 5];
    const ema = computeEMA(s, 12);
    for (const v of ema) expect(Math.abs(v - 5)).toBeLessThan(1e-6);
  });
});

describe('computeMACD', () => {
  it('返回与收盘价等长的 DIF/DEA/MACD', () => {
    const closes = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i / 3) * 5);
    const macd = computeMACD(closes);
    expect(macd).toHaveLength(closes.length);
    expect(typeof macd[30].dif).toBe('number');
    expect(typeof macd[30].dea).toBe('number');
    expect(typeof macd[30].macd).toBe('number');
  });

  it('macd = 2 * (dif - dea)', () => {
    const closes = Array.from({ length: 40 }, (_, i) => 100 + i * 0.1);
    const macd = computeMACD(closes);
    const last = macd[39];
    expect(Math.abs(last.macd - 2 * (last.dif - last.dea))).toBeLessThan(1e-6);
  });
});

describe('aggregateCandles', () => {
  const mk = (date: string, close: number, open = close): Candle => ({
    date,
    open,
    high: close + 1,
    low: close - 1,
    close,
    volume: 100,
  });

  it('日K 原样返回', () => {
    const daily = [mk('2024-01-02', 10), mk('2024-01-03', 11)];
    expect(aggregateCandles(daily, 'day')).toHaveLength(2);
  });

  it('周K 按周聚合：开盘取首日、收盘取末日、高低取区间、量求和', () => {
    // 2024-01-01 是周一；构造同一周内的 3 个交易日
    const daily = [
      mk('2024-01-01', 10, 9), // 周一 开9 收10
      mk('2024-01-02', 12), // 周二 收12
      mk('2024-01-03', 11), // 周三 收11（末日收盘）
    ];
    const week = aggregateCandles(daily, 'week');
    expect(week).toHaveLength(1);
    expect(week[0].open).toBe(9);
    expect(week[0].close).toBe(11);
    expect(week[0].high).toBe(13);
    expect(week[0].low).toBe(9);
    expect(week[0].volume).toBe(300);
  });

  it('月K 按 YYYY-MM 聚合', () => {
    const daily = [
      mk('2024-01-02', 10, 9),
      mk('2024-01-15', 12),
      mk('2024-02-01', 20, 18),
    ];
    const month = aggregateCandles(daily, 'month');
    expect(month).toHaveLength(2);
    expect(month[0].open).toBe(9);
    expect(month[0].close).toBe(12);
    expect(month[1].open).toBe(18);
    expect(month[1].close).toBe(20);
  });

  it('聚合结果按日期升序', () => {
    const daily = [mk('2024-03-01', 1), mk('2024-01-01', 2), mk('2024-02-01', 3)];
    const month = aggregateCandles(daily, 'month').map((c) => c.date);
    expect(month).toEqual([...month].sort());
  });

  it('空序列安全返回空', () => {
    expect(aggregateCandles([], 'month')).toEqual([]);
  });
});
