import { describe, it, expect } from 'vitest';
import { engleGranger } from '../cointegration.js';
import { gaussianStream } from '../linalg.js';

/** 随机游走（价格尺度，日波动 vol） */
function randomWalk(n: number, seed: number, vol = 0.01, start = 100): number[] {
  const g = gaussianStream(seed);
  const out: number[] = [start];
  for (let i = 1; i < n; i++) out.push(out[i - 1] * (1 + vol * g()));
  return out;
}

describe('engleGranger：协整判别', () => {
  it('真协整对（y = 0.8x + 平稳噪声）→ 判定协整、β 恢复、半衰期有限', () => {
    const x = randomWalk(600, 21);
    const g = gaussianStream(22);
    const y = x.map((v) => 0.8 * v + 0.3 * g());
    const r = engleGranger(y, x);

    expect(r.cointegratedAt5).toBe(true);
    expect(r.residualAdf.statistic).toBeLessThan(-3.34); // EG 5% 临界值
    expect(r.hedgeRatio).toBeGreaterThan(0.7);
    expect(r.hedgeRatio).toBeLessThan(0.9);
    expect(Number.isFinite(r.halfLife)).toBe(true);
    expect(r.halfLife).toBeLessThan(200);
    expect(r.ar1Phi).toBeLessThan(0); // 负 φ = 均值回复
    // z-score：均值≈0、标准差≈1
    const zm = r.zScore.reduce((a, b) => a + b, 0) / r.zScore.length;
    expect(Math.abs(zm)).toBeLessThan(0.2);
    expect(Number.isFinite(r.latestZ)).toBe(true);
  });

  it('独立随机游走对 → 不判定协整', () => {
    const x = randomWalk(600, 31);
    const y = randomWalk(600, 32);
    const r = engleGranger(y, x);
    expect(r.cointegratedAt5).toBe(false);
    expect(Number.isFinite(r.halfLife) === false || r.halfLife > 20).toBe(true);
  });

  it('残差 ADF 使用 EG 临界值（而非标准 ADF 临界值）', () => {
    const x = randomWalk(400, 41);
    const y = x.map((v) => 0.5 * v);
    const r = engleGranger(y, x);
    expect(r.residualAdf.criticalValues['5%']).toBeCloseTo(-3.34, 6);
    expect(r.residualAdf.criticalValues['1%']).toBeCloseTo(-3.9, 6);
  });

  it('长度不一致与样本不足均抛错', () => {
    expect(() => engleGranger([1, 2, 3], [1, 2])).toThrow(/长度不一致/);
    const x = randomWalk(50, 51);
    const y = x.map((v) => v + 1);
    expect(() => engleGranger(y, x)).toThrow(/至少 60 个对齐观测/);
  });
});
