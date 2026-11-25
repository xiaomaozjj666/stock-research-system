// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { formatMarketCap } from '../format';

describe('formatMarketCap', () => {
  it('小于一万亿按「亿」展示，四舍五入到整数', () => {
    expect(formatMarketCap(1234.56)).toBe('1235亿');
    expect(formatMarketCap(9999)).toBe('9999亿');
  });

  it('达到一万亿（10000 亿）改按「万亿」，保留 1 位小数', () => {
    expect(formatMarketCap(10000)).toBe('1.0万亿');
    expect(formatMarketCap(23456)).toBe('2.3万亿');
  });

  it('缺失、非有限值与非正数显示「—」，不把缺失当实测值', () => {
    expect(formatMarketCap(undefined)).toBe('—');
    expect(formatMarketCap(null)).toBe('—');
    expect(formatMarketCap(Number.NaN)).toBe('—');
    expect(formatMarketCap(Number.POSITIVE_INFINITY)).toBe('—');
    expect(formatMarketCap(0)).toBe('—');
    expect(formatMarketCap(-5)).toBe('—');
  });
});
