import { describe, it, expect } from 'vitest';
import { marketOf, resolveSecid, filterOHLCVByRange } from '../dataProvider.js';
import type { OHLCVData } from '../types.js';

describe('market resolution', () => {
  it('A-share keeps historical secid', () => {
    expect(marketOf('600519')).toBe('A');
    expect(resolveSecid('600519')).toBe('1.600519');
    expect(resolveSecid('000001')).toBe('0.000001');
    expect(resolveSecid('300750')).toBe('0.300750');
  });

  it('HK 5-digit codes map to 116.', () => {
    expect(marketOf('00700')).toBe('HK');
    expect(resolveSecid('00700')).toBe('116.00700');
  });

  it('US tickers map to 107. (uppercased)', () => {
    expect(marketOf('AAPL')).toBe('US');
    expect(resolveSecid('aapl')).toBe('107.AAPL');
  });
});

describe('filterOHLCVByRange look-ahead 防御', () => {
  function bar(date: string): OHLCVData {
    return { date, open: 10, close: 10, high: 11, low: 9, volume: 1000 };
  }

  it('范围内数据原样保留、trimmed=0', () => {
    const rows = [bar('2025-01-02'), bar('2025-01-03'), bar('2025-01-06')];
    const { data, trimmed } = filterOHLCVByRange(rows, '2025-01-01', '2025-01-31');
    expect(data).toHaveLength(3);
    expect(trimmed).toBe(0);
  });

  it('剔除 endDate 之后的未来行（回测混入未来数据会让 Sharpe/回撤失真）', () => {
    const rows = [bar('2025-01-02'), bar('2025-01-03'), bar('2025-01-31'), bar('2025-02-01')];
    const { data, trimmed } = filterOHLCVByRange(rows, '2025-01-01', '2025-01-31');
    expect(data.map((d) => d.date)).toEqual(['2025-01-02', '2025-01-03', '2025-01-31']);
    expect(trimmed).toBe(1); // 2025-02-01 被剔除
  });

  it('剔除 startDate 之前的越界行', () => {
    const rows = [bar('2024-12-30'), bar('2025-01-02'), bar('2025-01-03')];
    const { data, trimmed } = filterOHLCVByRange(rows, '2025-01-01', '2025-01-31');
    expect(data.map((d) => d.date)).toEqual(['2025-01-02', '2025-01-03']);
    expect(trimmed).toBe(1);
  });

  it('日期字符串兼容带/不带连字符的输入', () => {
    const rows = [bar('2025-01-02')];
    const { data, trimmed } = filterOHLCVByRange(rows, '20250101', '20250131');
    expect(data).toHaveLength(1);
    expect(trimmed).toBe(0);
  });

  it('空输入返回空', () => {
    const { data, trimmed } = filterOHLCVByRange([], '2025-01-01', '2025-01-31');
    expect(data).toEqual([]);
    expect(trimmed).toBe(0);
  });
});
