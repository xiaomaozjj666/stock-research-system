import { describe, it, expect } from 'vitest';
import {
  erf,
  normalCdf,
  logGamma,
  incompleteBeta,
  studentTTwoSidedP,
  sampleSkewness,
  sampleExcessKurtosis,
  winsorizeMad,
  olsRegression,
  holmAdjust,
  neweyWestTStat,
} from '../factorStats.js';

describe('erf', () => {
  it('erf(0) = 0，奇函数对称', () => {
    expect(erf(0)).toBeCloseTo(0, 12);
    expect(erf(1.5)).toBeCloseTo(-erf(-1.5), 12);
  });

  it('erf(1) ≈ 0.8427008（A&S 近似误差 < 1.5e-7）', () => {
    expect(erf(1)).toBeCloseTo(0.8427008, 6);
  });

  it('端点：±∞ → ±1，NaN 透传', () => {
    expect(erf(Infinity)).toBe(1);
    expect(erf(-Infinity)).toBe(-1);
    expect(Number.isNaN(erf(NaN))).toBe(true);
  });
});

describe('normalCdf', () => {
  it('Φ(0) = 0.5', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 12);
  });

  it('Φ(1.96) ≈ 0.975（对应双侧 5% 上分位）', () => {
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 5);
  });

  it('单调且有界', () => {
    expect(normalCdf(-5)).toBeLessThan(normalCdf(0));
    expect(normalCdf(0)).toBeLessThan(normalCdf(5));
    expect(normalCdf(-1e3)).toBeGreaterThanOrEqual(0);
    expect(normalCdf(1e3)).toBeLessThanOrEqual(1);
  });
});

describe('logGamma', () => {
  it('logΓ(1) = 0，logΓ(5) = log(24)', () => {
    expect(logGamma(1)).toBeCloseTo(0, 10);
    expect(logGamma(5)).toBeCloseTo(Math.log(24), 10);
  });

  it('logΓ(0.5) = log(√π)（检验反射公式分支）', () => {
    expect(logGamma(0.5)).toBeCloseTo(Math.log(Math.sqrt(Math.PI)), 10);
  });
});

describe('incompleteBeta', () => {
  it('I_x(1,1) = x（a=b=1 时退化为均匀分布）', () => {
    expect(incompleteBeta(0.5, 1, 1)).toBeCloseTo(0.5, 12);
    expect(incompleteBeta(0.25, 1, 1)).toBeCloseTo(0.25, 12);
  });

  it('端点钳制：x≤0 → 0，x≥1 → 1', () => {
    expect(incompleteBeta(0, 2, 3)).toBe(0);
    expect(incompleteBeta(1, 2, 3)).toBe(1);
  });

  it('对称恒等式 I_x(a,b) = 1 − I_{1−x}(b,a)', () => {
    for (const x of [0.1, 0.3, 0.7, 0.9]) {
      const lhs = incompleteBeta(x, 2.5, 3.5);
      const rhs = 1 - incompleteBeta(1 - x, 3.5, 2.5);
      expect(lhs).toBeCloseTo(rhs, 10);
    }
  });

  it('参数非正时返回 NaN', () => {
    expect(Number.isNaN(incompleteBeta(0.5, 0, 1))).toBe(true);
  });
});

describe('studentTTwoSidedP', () => {
  // 标准 t 分布双侧临界值表（α = 0.05）
  it('df=10 时 t=2.228 对应 p ≈ 0.05', () => {
    expect(studentTTwoSidedP(2.228, 10)).toBeCloseTo(0.05, 3);
  });

  it('df=3 时 t=3.182 对应 p ≈ 0.05', () => {
    expect(studentTTwoSidedP(3.182, 3)).toBeCloseTo(0.05, 3);
  });

  it('df=30 时 t=2.042 对应 p ≈ 0.05', () => {
    expect(studentTTwoSidedP(2.042, 30)).toBeCloseTo(0.05, 3);
  });

  it('自由度越大越接近正态：df=1e6 时 t=1.96 对应 p ≈ 0.05', () => {
    expect(studentTTwoSidedP(1.959964, 1e6)).toBeCloseTo(0.05, 3);
  });

  it('t=0 → p=1（完全无法拒绝原假设）', () => {
    expect(studentTTwoSidedP(0, 10)).toBe(1);
  });

  it('退化输入保守返回 1（不宣称显著）', () => {
    expect(studentTTwoSidedP(NaN, 10)).toBe(1);
    expect(studentTTwoSidedP(1.5, 0)).toBe(1);
    expect(studentTTwoSidedP(Infinity, 5)).toBe(1);
  });

  it('|t| 越大 p 越小（单调）', () => {
    expect(studentTTwoSidedP(3, 20)).toBeLessThan(studentTTwoSidedP(1, 20));
  });
});

describe('sampleSkewness', () => {
  it('完美对称分布偏度为 0', () => {
    expect(sampleSkewness([1, 2, 3, 4, 5])).toBeCloseTo(0, 10);
  });

  it('右偏分布偏度为正', () => {
    expect(sampleSkewness([1, 1, 1, 1, 10])).toBeGreaterThan(0);
  });

  it('样本 < 3 或方差为 0 时返回 0', () => {
    expect(sampleSkewness([1, 2])).toBe(0);
    expect(sampleSkewness([5, 5, 5, 5])).toBe(0);
  });
});

describe('sampleExcessKurtosis', () => {
  it('均匀分布（薄尾）超额峰度为负', () => {
    expect(sampleExcessKurtosis([1, 2, 3, 4, 5, 6, 7, 8])).toBeLessThan(0);
  });

  it('含极端离群值（厚尾）超额峰度为正', () => {
    expect(sampleExcessKurtosis([1, 1, 1, 1, 1, 1, 1, 1, 1, 50])).toBeGreaterThan(0);
  });

  it('样本 < 4 或方差为 0 时返回 0', () => {
    expect(sampleExcessKurtosis([1, 2, 3])).toBe(0);
    expect(sampleExcessKurtosis([2, 2, 2, 2])).toBe(0);
  });
});

describe('winsorizeMad', () => {
  it('把离群值截断到 median ± 3×1.4826×MAD', () => {
    const out = winsorizeMad([1, 2, 3, 4, 5, 6, 7, 1000]);
    expect(Math.max(...out)).toBeLessThan(1000);
    expect(Math.min(...out)).toBeGreaterThanOrEqual(1);
  });

  it('exclusive 模式下离群值替换为 NaN', () => {
    const out = winsorizeMad([1, 2, 3, 4, 5, 6, 7, 1000], 3, false);
    expect(out.some((v) => Number.isNaN(v))).toBe(true);
  });

  it('MAD = 0（过半取值相同）时不做处理', () => {
    const input = [5, 5, 5, 5, 5, 100];
    expect(winsorizeMad(input)).toEqual(input);
  });

  it('样本 < 3 时原样返回', () => {
    expect(winsorizeMad([1, 2])).toEqual([1, 2]);
  });
});

describe('olsRegression', () => {
  it('完美线性关系：y = 2 + 3x 的系数为 [2, 3]，R² = 1', () => {
    const x = [1, 2, 3, 4, 5];
    const y = x.map((v) => 2 + 3 * v);
    const { coefficients, r2, fullRank } = olsRegression(y, [x]);
    expect(fullRank).toBe(true);
    expect(coefficients[0]).toBeCloseTo(2, 8);
    expect(coefficients[1]).toBeCloseTo(3, 8);
    expect(r2).toBeCloseTo(1, 10);
  });

  it('残差与自变量正交（正规方程性质）', () => {
    const x = [1, 3, 5, 7, 9, 11];
    const y = [2, 5, 4, 10, 9, 13];
    const { residuals } = olsRegression(y, [x]);
    const dot = residuals.reduce((s, r, i) => s + r * x[i], 0);
    expect(dot).toBeCloseTo(0, 6);
  });

  it('多元回归可正确分离两个自变量的贡献', () => {
    const x1 = [1, 2, 3, 4, 5, 6];
    const x2 = [0, 1, 0, 1, 0, 1];
    const y = x1.map((v, i) => 1 + 2 * v + 5 * x2[i]);
    const { coefficients, r2 } = olsRegression(y, [x1, x2]);
    expect(coefficients[0]).toBeCloseTo(1, 8);
    expect(coefficients[1]).toBeCloseTo(2, 8);
    expect(coefficients[2]).toBeCloseTo(5, 8);
    expect(r2).toBeCloseTo(1, 10);
  });

  it('共线自变量（列不满秩）时回退为仅截距模型，不抛错', () => {
    const x = [1, 2, 3, 4];
    const y = [3, 5, 7, 9];
    const result = olsRegression(y, [x, x]); // 两列完全相同 → 奇异
    expect(result.fullRank).toBe(false);
    expect(result.r2).toBe(0);
    const mean = y.reduce((a, b) => a + b, 0) / y.length;
    expect(result.residuals).toEqual(y.map((v) => v - mean));
  });

  it('样本数少于参数个数时回退而非崩溃', () => {
    const result = olsRegression(
      [1, 2],
      [
        [1, 2],
        [3, 4],
        [5, 6],
      ],
    );
    expect(result.fullRank).toBe(false);
    expect(result.residuals).toHaveLength(2);
  });

  it('空输入不抛错', () => {
    const result = olsRegression([], [[]]);
    expect(result.residuals).toEqual([]);
  });
});

describe('holmAdjust Holm-Bonferroni 族错误率校正', () => {
  it('标准例子：p=[0.01,0.04,0.03,0.005] → [0.03,0.06,0.06,0.02]', () => {
    const adj = holmAdjust([0.01, 0.04, 0.03, 0.005]);
    expect(adj[3]).toBeCloseTo(0.02, 12); // 最小 p × 4
    expect(adj[0]).toBeCloseTo(0.03, 12); // 次小 p × 3
    expect(adj[2]).toBeCloseTo(0.06, 12); // 第三 × 2
    expect(adj[1]).toBeCloseTo(0.06, 12); // 最大 × 1，但被 step-down 单调性抬到 0.06
  });

  it('原始下标对齐：返回数组与输入一一对应', () => {
    const adj = holmAdjust([0.5, 0.001]);
    expect(adj[1]).toBeCloseTo(0.002, 12); // 0.001 × 2
    expect(adj[0]).toBeCloseTo(0.5, 12); // 0.5 × 1 = 0.5
  });

  it('校正后 p 单调不减于排序序、恒 ≥ raw p、clip 到 1', () => {
    const ps = [0.2, 0.6, 0.9, 0.3];
    const adj = holmAdjust(ps);
    adj.forEach((a, i) => {
      expect(a).toBeGreaterThanOrEqual(ps[i] - 1e-12);
      expect(a).toBeLessThanOrEqual(1);
    });
  });

  it('空数组安全', () => {
    expect(holmAdjust([])).toEqual([]);
  });
});

describe('neweyWestTStat Newey-West HAC 修正', () => {
  it('maxLag=0 等价 iid t；正自相关时 NW |t| 更保守', () => {
    const s = [1, 2, 3, 4, 5];
    // 手算：mean=3, γ0=2 → t0 = 3/√(2/5) = 4.7434…
    const t0 = neweyWestTStat(s, 0);
    expect(t0).toBeCloseTo(3 / Math.sqrt(2 / 5), 10);
    // γ1 = 0.8 → lrVar = 2 + 2×0.5×0.8 = 2.8 → |t1| = 3/√(2.8/5) < |t0|
    const t1 = neweyWestTStat(s, 1);
    expect(t1).toBeCloseTo(3 / Math.sqrt(2.8 / 5), 10);
    expect(Math.abs(t1)).toBeLessThan(Math.abs(t0));
  });

  it('强正自相关序列：NW se 大于 iid se → |t| 显著缩小', () => {
    // 缓慢单调序列：相邻观测高度正相关
    const slow = Array.from({ length: 60 }, (_, i) => Math.sin(i / 10));
    const mean = slow.reduce((a, b) => a + b, 0) / slow.length;
    const std = Math.sqrt(slow.reduce((s, v) => s + (v - mean) ** 2, 0) / (slow.length - 1));
    const iidT = mean / (std / Math.sqrt(slow.length));
    const tNw = neweyWestTStat(slow, 20);
    expect(Number.isFinite(tNw)).toBe(true);
    expect(Math.abs(tNw)).toBeLessThan(Math.abs(iidT));
  });

  it('退化序列（全常数）返回 NaN，由调用方按约定降级', () => {
    expect(Number.isNaN(neweyWestTStat([3, 3, 3, 3], 2))).toBe(true);
  });

  it('样本 < 2 返回 NaN', () => {
    expect(Number.isNaN(neweyWestTStat([1], 1))).toBe(true);
  });
});
