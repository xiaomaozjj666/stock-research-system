import { describe, it, expect } from 'vitest';
import {
  styleFactorExposures,
  decomposeRisk,
  type StyleExposures,
  type FactorInput,
} from '../riskAttribution.js';

describe('styleFactorExposures 风格因子暴露', () => {
  it('缺失输入全部返回 0（中性暴露）', () => {
    const e = styleFactorExposures({});
    expect(e).toEqual({ size: 0, value: 0, momentum: 0, profitability: 0, leverage: 0 });
  });

  it('大市值/低PE/高动量/高ROE/高负债 → 各维度正向暴露', () => {
    const e = styleFactorExposures({
      marketCap: 2000, // 远超基准 150
      pe: 10, // 低于基准 30 → 价值暴露高
      momentum: 0.5, // 高于基准 0.08
      roe: 30, // 高于基准 10
      debtRatio: 75, // 高于基准 45
    });
    expect(e.size).toBeGreaterThan(0);
    expect(e.value).toBeGreaterThan(0);
    expect(e.momentum).toBeGreaterThan(0);
    expect(e.profitability).toBeGreaterThan(0);
    expect(e.leverage).toBeGreaterThan(0);
  });

  it('小市值/高PE/负动量/低ROE/低负债 → 负向暴露', () => {
    const e = styleFactorExposures({
      marketCap: 10,
      pe: 100,
      momentum: -0.3,
      roe: 2,
      debtRatio: 20,
    });
    expect(e.size).toBeLessThan(0);
    expect(e.value).toBeLessThan(0);
    expect(e.momentum).toBeLessThan(0);
    expect(e.profitability).toBeLessThan(0);
    expect(e.leverage).toBeLessThan(0);
  });

  it('提供截面基准时按截面标准化（相对基准 ±1σ 附近）', () => {
    const cross = {
      mean: { marketCap: 100, pe: 20, momentum: 0.1, roe: 12, debtRatio: 40 },
      std: { marketCap: 50, pe: 10, momentum: 0.2, roe: 5, debtRatio: 15 },
    };
    const e = styleFactorExposures(
      { marketCap: 100, pe: 20, momentum: 0.1, roe: 12, debtRatio: 40 },
      cross,
    );
    // 与截面均值一致 → 暴露≈0
    expect(e.size).toBeCloseTo(0, 5);
    expect(e.momentum).toBeCloseTo(0, 5);
    expect(e.profitability).toBeCloseTo(0, 5);
    expect(e.leverage).toBeCloseTo(0, 5);
  });

  it('pe≤0 时价值暴露为 0（不除零）', () => {
    const e = styleFactorExposures({ pe: -5, marketCap: 100 });
    expect(e.value).toBe(0);
    expect(Number.isFinite(e.value)).toBe(true);
  });
});

describe('decomposeRisk 风险分解', () => {
  const neutral: StyleExposures = { size: 0, value: 0, momentum: 0, profitability: 0, leverage: 0 };

  it('零暴露时全部风险来自特异波动，explainedRatio=0', () => {
    const r = decomposeRisk(neutral, 20);
    expect(r.specificVol).toBe(20);
    expect(r.systematicVol).toBe(0);
    expect(r.totalVol).toBe(20);
    expect(r.explainedRatio).toBe(0);
  });

  it('高因子暴露时系统风险占比升高', () => {
    const high: StyleExposures = {
      size: 2,
      value: 1.5,
      momentum: 1,
      profitability: 0.5,
      leverage: 2,
    };
    const r = decomposeRisk(high, 10);
    expect(r.systematicVol).toBeGreaterThan(r.specificVol);
    expect(r.explainedRatio).toBeGreaterThan(0.5);
    // 总波动 = sqrt(sys² + spec²)（components 各自 round 后累计误差 ≤ 0.02）
    const fromComponents = Math.sqrt(r.systematicVol ** 2 + r.specificVol ** 2);
    expect(Math.abs(r.totalVol - fromComponents)).toBeLessThanOrEqual(0.02);
  });

  it('specificVol 为负时按 0 处理（容错）', () => {
    const r = decomposeRisk(neutral, -5);
    expect(r.specificVol).toBe(0);
    expect(r.totalVol).toBe(0);
  });

  it('组合接口可用性：暴露+分解全链路', () => {
    const input: FactorInput = { marketCap: 800, pe: 15, momentum: 0.3, roe: 22, debtRatio: 60 };
    const e = styleFactorExposures(input);
    const r = decomposeRisk(e, 18);
    expect(r.totalVol).toBeGreaterThan(0);
    expect(r.explainedRatio).toBeGreaterThanOrEqual(0);
    expect(r.explainedRatio).toBeLessThanOrEqual(1);
  });
});
