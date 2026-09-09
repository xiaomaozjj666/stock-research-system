import { describe, it, expect } from 'vitest';
import { fitGarch, fitEgarch, fitVolatilityModels, simulateGarch } from '../garch.js';

describe('simulateGarch', () => {
  it('同 seed 完全可复现', () => {
    const a = simulateGarch(200, { mu: 0, omega: 2e-6, alpha: 0.08, beta: 0.88 }, 42);
    const b = simulateGarch(200, { mu: 0, omega: 2e-6, alpha: 0.08, beta: 0.88 }, 42);
    expect(a.returns).toEqual(b.returns);
    expect(a.condVariance).toEqual(b.condVariance);
  });

  it('无条件方差收敛到 ω/(1−α−β) 的量级', () => {
    const { condVariance } = simulateGarch(
      5000,
      { mu: 0, omega: 2e-6, alpha: 0.08, beta: 0.88 },
      7,
    );
    const tail = condVariance.slice(1000);
    const avg = tail.reduce((a, b) => a + b, 0) / tail.length;
    expect(avg).toBeGreaterThan(3e-5); // 理论值 5e-5，波动聚集下取宽松区间
    expect(avg).toBeLessThan(8e-5);
  });
});

describe('fitGarch：参数恢复', () => {
  const sim = simulateGarch(1500, { mu: 0.0002, omega: 2e-6, alpha: 0.08, beta: 0.88 }, 11);
  const fit = fitGarch(sim.returns);

  it('结构字段齐全且收敛', () => {
    expect(fit.model).toBe('garch');
    expect(fit.converged).toBe(true);
    expect(Number.isFinite(fit.logLik)).toBe(true);
    expect(Number.isFinite(fit.aic)).toBe(true);
    expect(fit.bic).toBeGreaterThan(fit.aic);
  });

  it('参数恢复在有限样本偏差的宽松区间内（α≈0.08, β≈0.88）', () => {
    expect(fit.alpha).toBeGreaterThan(0);
    expect(fit.alpha).toBeLessThan(0.25);
    expect(fit.beta).toBeGreaterThan(0.7);
    expect(fit.beta).toBeLessThan(0.99);
    expect(fit.persistence).toBeCloseTo(fit.alpha + fit.beta, 12);
    expect(fit.persistence).toBeLessThan(1);
    expect(fit.persistence).toBeGreaterThan(0.7); // 高持续性被识别
  });

  it('条件方差全为正、一步预测为正且年化口径正确', () => {
    expect(fit.condVariance.every((v) => Number.isFinite(v) && v > 0)).toBe(true);
    expect(fit.forecast.sigma2).toBeGreaterThan(0);
    expect(fit.forecast.sigmaAnnualized).toBeCloseTo(fit.forecast.sigmaDaily * Math.sqrt(252), 12);
    // 模拟 unconditional 日波动 ≈ √5e-5 ≈ 0.71%，预测应在 0.3%–2% 区间
    expect(fit.forecast.sigmaDaily).toBeGreaterThan(0.003);
    expect(fit.forecast.sigmaDaily).toBeLessThan(0.02);
  });

  it('样本不足抛错', () => {
    expect(() => fitGarch(new Array(50).fill(0.001))).toThrow(/至少 60 个观测/);
  });
});

describe('fitEgarch', () => {
  const sim = simulateGarch(1200, { mu: 0, omega: 2e-6, alpha: 0.08, beta: 0.88 }, 13);
  const fit = fitEgarch(sim.returns);

  it('收敛、字段齐全、β 高持续性', () => {
    expect(fit.model).toBe('egarch');
    expect(fit.converged).toBe(true);
    expect(Number.isFinite(fit.gamma)).toBe(true);
    expect(fit.beta).toBeGreaterThan(0.6);
    expect(fit.forecast.sigma2).toBeGreaterThan(0);
    expect(fit.condVariance.every((v) => Number.isFinite(v) && v > 0)).toBe(true);
  });

  it('对称模拟数据下不应误报强杠杆效应', () => {
    // 数据由对称 GARCH 生成，γ 应接近 0；只允许方向性提示而非强信号
    expect(fit.gamma).toBeGreaterThan(-0.3);
  });
});

describe('fitVolatilityModels', () => {
  it('同时拟合两模型并按 BIC 给出偏好', () => {
    const { returns } = simulateGarch(900, { mu: 0, omega: 1e-6, alpha: 0.05, beta: 0.9 }, 17);
    const r = fitVolatilityModels(returns);
    expect(['garch', 'egarch']).toContain(r.prefer);
    // 高斯密度值可大于 1，logLik 常为正 → AIC/BIC 允许为负；
    // 有效判据是 BIC ≥ AIC（n>e² 时惩罚差为正）且均有限
    expect(Number.isFinite(r.garch.bic)).toBe(true);
    expect(Number.isFinite(r.egarch.bic)).toBe(true);
    expect(r.garch.bic).toBeGreaterThanOrEqual(r.garch.aic);
    expect(r.egarch.bic).toBeGreaterThanOrEqual(r.egarch.aic);
  });
});
