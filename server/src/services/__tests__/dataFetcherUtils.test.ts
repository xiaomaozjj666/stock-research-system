import { describe, it, expect } from 'vitest';
import { toNum, yuanToYi, toPercent } from '../dataFetcher.js';

describe('toNum', () => {
  it('null/undefined/"-" 归零', () => {
    expect(toNum(null)).toBe(0);
    expect(toNum(undefined)).toBe(0);
    expect(toNum('-')).toBe(0);
  });
  it('字符串数字正常转换', () => {
    expect(toNum('123')).toBe(123);
    expect(toNum('3.14')).toBe(3.14);
  });
  it('数字原样返回', () => {
    expect(toNum(45)).toBe(45);
    expect(toNum(-7.5)).toBe(-7.5);
  });
  it('非数字字符串归零', () => {
    expect(toNum('abc')).toBe(0);
    expect(toNum('')).toBe(0);
  });
  it('NaN 归零', () => {
    expect(toNum(Number.NaN)).toBe(0);
  });
});

describe('yuanToYi', () => {
  it('元转亿元（除以 1e8，保留2位）', () => {
    expect(yuanToYi(1e8)).toBe(1);
    expect(yuanToYi(1.5e8)).toBe(1.5);
    expect(yuanToYi('200000000')).toBe(2);
  });
  it('0 值返回 0，不出现 -0', () => {
    expect(yuanToYi(0)).toBe(0);
    expect(yuanToYi(null)).toBe(0);
  });
  it('大数值正确换算', () => {
    expect(yuanToYi(3.609561e12)).toBeCloseTo(36095.61, 1);
  });
});

describe('toPercent', () => {
  it('已是百分比形式直接四舍五入（如 91.5 → 91.5）', () => {
    expect(toPercent(91.5)).toBe(91.5);
    expect(toPercent('76.9')).toBe(76.9);
  });
  it('回归保护：负债率 ≥100 不被误判为小数（105 → 105，而非 10500）', () => {
    expect(toPercent(105)).toBe(105);
    expect(toPercent(120.3)).toBe(120.3);
  });
  it('小数形式（如 0.915）乘以 100', () => {
    expect(toPercent(0.915)).toBe(91.5);
  });
  it('0 值返回 0', () => {
    expect(toPercent(0)).toBe(0);
    expect(toPercent(null)).toBe(0);
  });
  it('负值保持符号', () => {
    expect(toPercent(-5.2)).toBe(-5.2);
  });
});
