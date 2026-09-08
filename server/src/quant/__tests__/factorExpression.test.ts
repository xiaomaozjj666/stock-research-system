import { describe, it, expect } from 'vitest';
import {
  parseFactorExpression,
  buildExpressionContext,
  evaluateFactorExpression,
  evaluateFactorSeries,
  MAX_EXPRESSION_CHARS,
} from '../factorExpression.js';
import type { OHLCVData } from '../types.js';

/** close = 1..n 的确定性 K 线，便于手算断言 */
function makeBars(n: number): OHLCVData[] {
  return Array.from({ length: n }, (_, i) => ({
    date: `2024-01-${String((i % 28) + 1).padStart(2, '0')}`,
    open: i + 1,
    high: i + 2,
    low: i,
    close: i + 1,
    volume: 1000 + i,
  }));
}

describe('parseFactorExpression — 语法与安全边界', () => {
  it('解析合法表达式', () => {
    const node = parseFactorExpression('close / mean(close, 5) - 1');
    expect(node.kind).toBe('binary');
  });

  it('拒绝未授权的标识符（无属性访问、无原型链）', () => {
    for (const bad of ['__proto__', 'constructor', 'prototype', 'process', 'globalThis']) {
      expect(() => parseFactorExpression(bad)).toThrow(/未授权的标识符/);
    }
  });

  it('拒绝未授权的函数（不存在任意代码执行面）', () => {
    for (const bad of ['exec(1)', 'eval(1)', 'require("fs")', 'fetch(1)']) {
      expect(() => parseFactorExpression(bad)).toThrow(/未授权的函数|非法字符|参数/);
    }
  });

  it('函数元数不匹配 → 抛错', () => {
    expect(() => parseFactorExpression('mean(close)')).toThrow(/需要 2 个参数/);
    expect(() => parseFactorExpression('abs(close, 2)')).toThrow(/需要 1 个参数/);
  });

  it('语法错误（缺右括号 / 尾部多余 / 空串）→ 抛错', () => {
    expect(() => parseFactorExpression('mean(close, 5')).toThrow(/右括号/);
    expect(() => parseFactorExpression('close 5')).toThrow(/多余内容/);
    expect(() => parseFactorExpression('   ')).toThrow(/表达式为空/);
  });

  it('超长表达式 → 抛错（防止构造超大 AST）', () => {
    const long = `close${' + 1'.repeat(MAX_EXPRESSION_CHARS)}`;
    expect(() => parseFactorExpression(long)).toThrow(/表达式过长/);
  });

  it('节点数超限 → 抛错（用每字符 1 节点的密集表达式，避开长度上限）', () => {
    // '1' 1 节点；每追加 '+1' 2 节点 / 2 字符 → 121 节点时仍在 240 字符内
    const deep = `1${'+1'.repeat(60)}`;
    expect(deep.length).toBeLessThan(MAX_EXPRESSION_CHARS);
    expect(() => parseFactorExpression(deep)).toThrow(/过于复杂/);
  });
});

describe('evaluateFactorExpression — 求值语义', () => {
  const bars = makeBars(10);

  it('窗口均值：close / mean(close,5) - 1 在 i=4 处为 0（5/3 - 1 需手算）', () => {
    // close = 1..10；i=4 → close=5，mean(close,5) = (1+2+3+4+5)/5 = 3 → 5/3-1
    const out = evaluateFactorExpression('close / mean(close, 5) - 1', bars);
    expect(out[4]).toBeCloseTo(5 / 3 - 1, 12);
  });

  it('delay 取历史值，首窗口越界为 NaN', () => {
    const out = evaluateFactorExpression('delay(close, 2)', bars);
    expect(out[0]).toBeNaN();
    expect(out[1]).toBeNaN();
    expect(out[2]).toBeCloseTo(1, 12);
  });

  it('min/max/sum/std 按窗口计算', () => {
    expect(evaluateFactorExpression('min(close, 3)', bars)[4]).toBeCloseTo(3, 12);
    expect(evaluateFactorExpression('max(close, 3)', bars)[4]).toBeCloseTo(5, 12);
    expect(evaluateFactorExpression('sum(close, 3)', bars)[4]).toBeCloseTo(12, 12);
    expect(evaluateFactorExpression('std(close, 5)', bars)[4]).toBeGreaterThan(0);
  });

  it('除零与非有限值一律落 NaN，不外抛', () => {
    const out = evaluateFactorExpression('close / (close - close)', bars);
    expect(out.every((v) => Number.isNaN(v))).toBe(true);
  });

  it('窗口参数越界（>250 或非整数）→ NaN', () => {
    const out = evaluateFactorExpression('mean(close, 9999)', bars);
    expect(out[4]).toBeNaN();
  });

  it('ret 序列首日为 0，其余为日收益率', () => {
    const out = evaluateFactorExpression('ret', bars);
    expect(out[0]).toBe(0);
    expect(out[1]).toBeCloseTo(2 / 1 - 1, 12);
  });

  it('abs/log/sqrt 单参函数', () => {
    expect(evaluateFactorExpression('abs(-1 * close)', bars)[0]).toBeCloseTo(1, 12);
    expect(evaluateFactorExpression('log(close)', bars)[0]).toBeCloseTo(0, 12);
    expect(evaluateFactorExpression('sqrt(close)', bars)[3]).toBeCloseTo(2, 12);
  });

  it('corr 窗口相关性：自身相关为 1', () => {
    expect(evaluateFactorExpression('corr(close, close, 5)', bars)[4]).toBeCloseTo(1, 6);
  });

  it('基本面标量可引用（缺财务数据时为 NaN）', () => {
    const noFin = evaluateFactorExpression('roe', bars);
    expect(noFin[0]).toBeNaN();
    const ctx = buildExpressionContext(bars, {
      years: ['2024'],
      revenue: [100],
      netProfit: [10, 20],
      grossMargin: [50],
      netMargin: [10],
      roe: [12.5],
      operatingCashFlow: [5],
      eps: [1],
      totalAssets: [200],
      totalLiabilities: [80],
      equity: [120],
      accountsReceivable: [1],
      inventory: [1],
      goodwill: [0],
      debtRatio: [40],
    } as never);
    expect(evaluateFactorSeries(parseFactorExpression('roe'), ctx)[0]).toBeCloseTo(12.5, 12);
  });
});
