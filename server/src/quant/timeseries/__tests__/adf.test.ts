import { describe, it, expect } from 'vitest';
import { adfTest, schwertMaxLag } from '../adf.js';
import { gaussianStream } from '../linalg.js';

/** 白噪声（确定性种子） */
function whiteNoise(n: number, seed: number): number[] {
  const g = gaussianStream(seed);
  return Array.from({ length: n }, () => g());
}

/** 随机游走（白噪声累加，价格尺度 100 起） */
function randomWalk(n: number, seed: number): number[] {
  const g = gaussianStream(seed);
  const out: number[] = [100];
  for (let i = 1; i < n; i++) out.push(out[i - 1] + g());
  return out;
}

describe('schwertMaxLag', () => {
  it('标准规则：n=100 → 12，n=500 → 17，并受 n/2−2 上限约束', () => {
    expect(schwertMaxLag(100)).toBe(12);
    expect(schwertMaxLag(500)).toBe(Math.floor(12 * Math.pow(5, 0.25)));
    expect(schwertMaxLag(10)).toBe(3); // floor(10/2)−2
  });
});

describe('adfTest：平稳性判别', () => {
  it('白噪声 → 拒绝单位根（平稳）', () => {
    const r = adfTest(whiteNoise(500, 1), { spec: 'c' });
    expect(Number.isFinite(r.statistic)).toBe(true);
    expect(r.statistic).toBeLessThan(-2.86); // 5% 渐近临界值
    expect(r.rejectAt5).toBe(true);
    expect(r.pValue).toBeLessThan(0.05);
  });

  it('随机游走 → 不能拒绝单位根', () => {
    const r = adfTest(randomWalk(500, 2), { spec: 'c' });
    expect(r.statistic).toBeGreaterThan(-2.86);
    expect(r.rejectAt5).toBe(false);
    expect(r.pValue).toBeGreaterThan(0.1);
  });

  it('随机游走一阶差分后 → 拒绝（I(1) 序列差分即平稳）', () => {
    const rw = randomWalk(500, 3);
    const d1 = rw.slice(1).map((v, i) => v - rw[i]);
    const r = adfTest(d1, { spec: 'c' });
    expect(r.rejectAt5).toBe(true);
  });

  it('spec 三种设定都能返回一致结构', () => {
    for (const spec of ['n', 'c', 'ct'] as const) {
      const r = adfTest(whiteNoise(300, 4), { spec });
      expect(r.spec).toBe(spec);
      expect(r.criticalValues['5%']).toBeLessThan(r.criticalValues['10%']);
      expect(r.criticalValues['1%']).toBeLessThan(r.criticalValues['5%']);
      expect(r.nobs).toBeGreaterThan(200);
    }
  });

  it('选阶轨迹完整且在 [0, maxLag] 内', () => {
    const r = adfTest(whiteNoise(400, 5), { spec: 'c' });
    expect(r.lag).toBeGreaterThanOrEqual(0);
    expect(r.lag).toBeLessThanOrEqual(r.lagSelection.maxLag);
    expect(r.lagSelection.scores.length).toBeGreaterThan(0);
  });

  it('样本过少直接抛错', () => {
    expect(() => adfTest([1, 2, 3], { spec: 'c' })).toThrow(/至少 8 个观测/);
  });
});
