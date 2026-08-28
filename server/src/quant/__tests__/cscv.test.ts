import { describe, it, expect } from 'vitest';
import { computePbo } from '../cscv.js';

// ============================================================
// 合成数据工具（固定 seed，保证测试可复现）
// ============================================================

/** 确定性伪随机数生成器（mulberry32） */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller 标准正态随机数 */
function normal(rand: () => number, mean = 0, std = 1): number {
  const u = Math.max(rand(), 1e-9);
  const v = Math.max(rand(), 1e-9);
  return mean + std * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * 合成收益矩阵：rows 天 × cols 个策略。
 * 第 c 列均值由 means[c] 给定（缺省 0），统一标准差 0.01。
 */
function synthReturns(rows: number, cols: number, seed: number, means: number[] = []): number[][] {
  const rand = mulberry32(seed);
  const m: number[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: number[] = [];
    for (let c = 0; c < cols; c++) {
      row.push(normal(rand, means[c] ?? 0, 0.01));
    }
    m.push(row);
  }
  return m;
}

// ============================================================
// computePbo —— 组合对称交叉验证
// ============================================================

describe('computePbo — 组合数与配置', () => {
  it('S=8 时组合数 = C(8,4) = 70', () => {
    const res = computePbo(synthReturns(200, 5, 1), { numBlocks: 8 });
    expect(res.nCombinations).toBe(70);
    expect(res.numBlocks).toBe(8);
    expect(res.numStrategies).toBe(5);
  });

  it('S=10 时组合数 = C(10,5) = 252', () => {
    const res = computePbo(synthReturns(300, 6, 2), { numBlocks: 10 });
    expect(res.nCombinations).toBe(252);
    expect(res.numBlocks).toBe(10);
  });

  it('奇数 numBlocks 自动修正为偶数', () => {
    const res = computePbo(synthReturns(300, 6, 3), { numBlocks: 9 });
    expect(res.numBlocks).toBe(8);
    expect(res.nCombinations).toBe(70);
  });

  it('收益矩阵过小或非矩形时抛错', () => {
    expect(() => computePbo([])).toThrow();
    expect(() => computePbo([[0.1], [0.2]])).toThrow(); // 只有 1 个策略
    expect(() => computePbo([[0.1, 0.2], [0.3]])).toThrow(); // 非矩形
  });
});

describe('computePbo — PBO 语义', () => {
  it('纯随机策略：平均 PBO 接近 0.5（选优近乎靠运气）', () => {
    // 单 seed 下 PBO 波动较大（策略数/组合数有限），对固定 seed 列表取均值更稳健
    const seeds = [1, 2, 3, 5, 9, 21, 42, 99, 123, 777];
    const pbos = seeds.map((seed) => computePbo(synthReturns(400, 8, seed), { numBlocks: 8 }).pbo);
    const meanPbo = pbos.reduce((a, b) => a + b, 0) / pbos.length;
    // 8 个纯噪声策略下 IS 最优在 OOS 无优势，平均 PBO 应贴近 0.5，而非 0 或 1
    expect(meanPbo).toBeGreaterThanOrEqual(0.35);
    expect(meanPbo).toBeLessThanOrEqual(0.65);
    // 任一单 seed 的 relativeRanks 长度正确
    expect(computePbo(synthReturns(400, 8, 42), { numBlocks: 8 }).relativeRanks).toHaveLength(70);
  });

  it('确定性：同输入同结果', () => {
    const rets = synthReturns(300, 6, 11);
    const a = computePbo(rets, { numBlocks: 8 });
    const b = computePbo(rets, { numBlocks: 8 });
    expect(b.pbo).toBe(a.pbo);
    expect(b.relativeRanks).toEqual(a.relativeRanks);
  });

  it('单一显著策略：PBO 很低（IS 最优在 OOS 稳定占优）', () => {
    // 策略 0 有稳定正 alpha（日均值 0.2%，Sharpe 约 0.2/日），其余为噪声
    const rets = synthReturns(400, 5, 7, [0.002, 0, 0, 0, 0]);
    const res = computePbo(rets, { numBlocks: 8 });
    expect(res.pbo).toBeLessThanOrEqual(0.15);
    // 诊断：显著策略的 OOS 平均绩效应明显高于其他策略
    const bestIdx = res.sharpeMatrix.is.indexOf(Math.max(...res.sharpeMatrix.is));
    expect(res.sharpeMatrix.oos[bestIdx]).toBeGreaterThan(
      Math.max(...res.sharpeMatrix.oos.filter((_, i) => i !== bestIdx)),
    );
  });

  it('meanReturn 指标下结果同样合理', () => {
    const rets = synthReturns(300, 6, 13, [0.002, 0, 0, 0, 0, 0]);
    const res = computePbo(rets, { numBlocks: 8, performance: 'meanReturn' });
    expect(res.pbo).toBeLessThanOrEqual(0.15);
  });
});
