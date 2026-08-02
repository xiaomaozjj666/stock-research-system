import { describe, it, expect } from 'vitest';
import { safeDiv } from '../safeDiv.js';

describe('safeDiv', () => {
  it('正常除法', () => {
    expect(safeDiv(10, 2)).toBe(5);
    expect(safeDiv(1, 4)).toBe(0.25);
  });

  it('分子为 0 时返回 0', () => {
    expect(safeDiv(0, 5)).toBe(0);
  });

  it('分母为 0 时返回 fallback（默认 0）', () => {
    expect(safeDiv(10, 0)).toBe(0);
    expect(safeDiv(10, 0, -1)).toBe(-1);
  });

  it('分母为 NaN 时返回 fallback', () => {
    expect(safeDiv(10, Number.NaN)).toBe(0);
    expect(safeDiv(10, Number.NaN, 99)).toBe(99);
  });

  it('分母为 Infinity 时返回 fallback', () => {
    expect(safeDiv(10, Number.POSITIVE_INFINITY)).toBe(0);
    expect(safeDiv(10, Number.NEGATIVE_INFINITY, 7)).toBe(7);
  });

  it('分子为 Infinity 时正常参与运算（不触发 fallback）', () => {
    expect(safeDiv(Number.POSITIVE_INFINITY, 2)).toBe(Number.POSITIVE_INFINITY);
  });
});
