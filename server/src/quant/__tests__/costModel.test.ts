import { describe, it, expect } from 'vitest';
import {
  DEFAULT_COST_MODEL,
  A_SHARE_COST_MODEL,
  makeCostModel,
  buyCost,
  sellProceeds,
} from '../costModel.js';

describe('costModel 可插拔成本模型', () => {
  it('默认模型为佣金双边对称、无最低费用（历史行为）', () => {
    expect(DEFAULT_COST_MODEL).toEqual({
      openRate: 0.0003,
      closeRate: 0.0003,
      minCost: 0,
      slippage: 0.001,
    });
  });

  it('A 股真实费率模型：卖出费率 = 佣金 + 印花税（仅卖出单边）', () => {
    expect(A_SHARE_COST_MODEL.openRate).toBeCloseTo(0.00025, 6);
    // 佣金万2.5 + 印花税万5 → 万7.5
    expect(A_SHARE_COST_MODEL.closeRate).toBeCloseTo(0.00075, 6);
    expect(A_SHARE_COST_MODEL.minCost).toBe(5);
    // 印花税只收卖出：closeRate > openRate
    expect(A_SHARE_COST_MODEL.closeRate).toBeGreaterThan(A_SHARE_COST_MODEL.openRate);
  });

  it('makeCostModel 以默认模型为底合并覆盖字段', () => {
    const m = makeCostModel({ openRate: 0.0001, minCost: 1 });
    expect(m.openRate).toBe(0.0001);
    expect(m.closeRate).toBe(DEFAULT_COST_MODEL.closeRate);
    expect(m.minCost).toBe(1);
    expect(m.slippage).toBe(DEFAULT_COST_MODEL.slippage);
  });

  it('buyCost 总支出 = 成交额 + 费用，费用按 openRate', () => {
    // 10000 股 × 10 元 = 10 万元；费率万2.5 → 费用 25 元（> minCost=5，按比例）
    const { total, fee } = buyCost(A_SHARE_COST_MODEL, 10000, 10);
    expect(fee).toBeCloseTo(25, 6);
    expect(total).toBeCloseTo(100025, 6);
  });

  it('sellProceeds 净收入 = 成交额 − 费用，费用按 closeRate（含印花税）', () => {
    // 1000 股 × 10 元 = 10000 元；卖出费率万7.5 → 费用 7.5 元
    const { proceeds, fee } = sellProceeds(A_SHARE_COST_MODEL, 1000, 10);
    expect(fee).toBeCloseTo(7.5, 6);
    expect(proceeds).toBeCloseTo(9992.5, 6);
  });

  it('minCost 兜底：小额成交费用不低于最低佣金', () => {
    // 100 股 × 1 元 = 100 元；佣金 0.025 元 < 5 元 → 按 5 元收取
    const { total, fee } = buyCost(A_SHARE_COST_MODEL, 100, 1);
    expect(fee).toBe(5);
    expect(total).toBe(105);
  });

  it('minCost=0 时费用按比例（无兜底）', () => {
    const { fee } = buyCost(DEFAULT_COST_MODEL, 1000, 10);
    expect(fee).toBeCloseTo(3, 6); // 10000 × 0.0003
  });
});
