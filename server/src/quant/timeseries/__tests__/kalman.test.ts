import { describe, it, expect } from 'vitest';
import { localLevelFilter, timeVaryingBeta } from '../kalman.js';
import { gaussianStream } from '../linalg.js';

describe('localLevelFilter', () => {
  it('滤波输出比原始序列更平滑（差分能量更小）', () => {
    const g = gaussianStream(101);
    const series = Array.from({ length: 300 }, (_, i) => 100 + 0.2 * Math.sin(i / 20) + 2 * g());
    const r = localLevelFilter(series, { qRatio: 0.05 });
    const diffEnergy = (xs: number[]): number =>
      xs.slice(1).reduce((a, v, i) => a + (v - xs[i]) ** 2, 0);
    expect(diffEnergy(r.level)).toBeLessThan(diffEnergy(series));
    expect(r.innovationStdRatio).toBeGreaterThan(0);
    expect(r.oneStepErrors.length).toBe(series.length);
  });

  it('qRatio 越大滤波越贴合原始序列', () => {
    const g = gaussianStream(103);
    const series = Array.from({ length: 200 }, () => 100 + g());
    const tight = localLevelFilter(series, { qRatio: 2 });
    const smooth = localLevelFilter(series, { qRatio: 0.01 });
    const track = (lv: number[]): number =>
      lv.reduce((a, v, i) => a + Math.abs(v - series[i]), 0) / lv.length;
    expect(track(tight.level)).toBeLessThan(track(smooth.level));
  });

  it('样本不足抛错', () => {
    expect(() => localLevelFilter([1, 2, 3])).toThrow(/至少 10 个观测/);
  });
});

describe('timeVaryingBeta', () => {
  it('β 正弦漂移场景：滤波跟踪误差低于静态 OLS', () => {
    const g = gaussianStream(111);
    const n = 500;
    const x: number[] = [100];
    for (let i = 1; i < n; i++) x.push(x[i - 1] * (1 + 0.01 * g()));
    const trueBeta = (i: number): number => 0.8 + 0.4 * Math.sin(i / 60);
    const y = x.map((v, i) => trueBeta(i) * v + 0.2 * g());
    const r = timeVaryingBeta(y, x, { qRatio: 1e-3 });

    expect(r.filterRmse).toBeLessThan(r.staticRmse);
    expect(Number.isFinite(r.finalHedgeRatio)).toBe(true);
    expect(r.hedgeRatio.length).toBe(n);
    expect(r.intercept.length).toBe(n);
    // 期末 β 应更接近真值期末 β（0.8 + 0.4·sin(499/60) ≈ 0.8+0.4·(−0.36) ≈ 0.66）
    const trueFinal = trueBeta(n - 1);
    expect(Math.abs(r.finalHedgeRatio - trueFinal)).toBeLessThan(
      Math.abs(r.staticHedgeRatio - trueFinal) + 0.05,
    );
  });

  it('恒定 β 场景：期末 β 收敛到真值附近', () => {
    const g = gaussianStream(121);
    const n = 400;
    const x: number[] = [50];
    for (let i = 1; i < n; i++) x.push(x[i - 1] + 0.5 * g());
    const y = x.map((v) => 2 + 1.5 * v + 0.3 * g());
    const r = timeVaryingBeta(y, x, { qRatio: 1e-5 });
    expect(Math.abs(r.finalHedgeRatio - 1.5)).toBeLessThan(0.1);
    expect(Math.abs(r.recentDrift)).toBeLessThan(0.05); // 稳态下漂移应很小
  });

  it('长度不一致与样本不足抛错', () => {
    expect(() => timeVaryingBeta([1, 2, 3], [1, 2])).toThrow(/长度不一致/);
    const x = [1, 2, 3, 4, 5];
    expect(() => timeVaryingBeta(x, x)).toThrow(/至少 30 个对齐观测/);
  });
});
