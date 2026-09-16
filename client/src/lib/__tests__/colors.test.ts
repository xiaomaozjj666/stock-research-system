import { describe, it, expect } from 'vitest';
import { signCls, significanceCls, CHART_COLOR } from '../colors';

describe('signCls —— 收益/涨跌方向（A 股：红涨绿跌）', () => {
  it('正数 → val-positive（红）', () => {
    expect(signCls(12.3)).toBe('val-positive');
    expect(signCls(0.0001)).toBe('val-positive');
  });

  it('负数 → val-negative（绿）', () => {
    expect(signCls(-3)).toBe('val-negative');
  });

  it('0 / NaN / null / undefined → 中性（0 既不是涨也不是跌）', () => {
    expect(signCls(0)).toBe('val-neutral');
    expect(signCls(Number.NaN)).toBe('val-neutral');
    expect(signCls(null)).toBe('val-neutral');
    expect(signCls(undefined)).toBe('val-neutral');
  });

  it('回归：不再借用显著性色板（正收益曾经显示成绿色 .sig-valid）', () => {
    expect(signCls(8.8)).not.toBe('sig-valid');
    expect(signCls(-8.8)).not.toBe('sig-inverted');
    expect(signCls(9)).not.toContain('sig-');
  });
});

describe('significanceCls —— 统计显著性 / OOS 通过（沿用既有 .sig-* 色板）', () => {
  it('valid / inverted / none 映射到既有类名', () => {
    expect(significanceCls('valid')).toBe('sig-valid');
    expect(significanceCls('inverted')).toBe('sig-inverted');
    expect(significanceCls('none')).toBe('sig-none');
  });
});

describe('CHART_COLOR —— 图表取色令牌', () => {
  // ECharts 画在 canvas 上，'var(--accent)' 是无效值（会静默画成黑色），
  // 因此这里锁死与 index.css :root 一致的字面量，改主题色时两边一起改
  it('与 index.css 的设计令牌同值', () => {
    expect(CHART_COLOR.accent).toBe('#4c8dff');
    expect(CHART_COLOR.border).toBe('#232b37');
    expect(CHART_COLOR.textPrimary).toBe('#e9edf3');
    expect(CHART_COLOR.textSecondary).toBe('#9ba6b4');
    expect(CHART_COLOR.textMuted).toBe('#7c8899');
  });

  it('不含 CSS 变量写法（canvas 解析不了）', () => {
    for (const v of Object.values(CHART_COLOR)) {
      expect(v).not.toContain('var(');
    }
  });
});
