/**
 * 线性代数底座测试（ADF/协整的数值正确性依赖这层，此前仅有间接覆盖）
 * ----------------------------------------------------------------------------
 * 覆盖：求解/求逆的数学恒等式、奇异与形状非法路径（静默 NaN 是这里最大的坑）、
 * OLS 系数/标准误/R²、无截距口径、退化输入、以及确定性高斯流。
 */
import { describe, it, expect } from 'vitest';
import { gaussianStream, invertMatrix, olsWithStats, solveLinearSystem } from '../linalg.js';

describe('solveLinearSystem', () => {
  it('3×3 唯一解（手算验证）', () => {
    // 代入验证：3x - y + 2z 在 (1,2,3) 处 = 3-2+6 = 7（不是 11）
    // x + 2y + 3z = 14; 2x + y + z = 7; 3x - y + 2z = 7 → x=1, y=2, z=3
    const x = solveLinearSystem(
      [
        [1, 2, 3],
        [2, 1, 1],
        [3, -1, 2],
      ],
      [14, 7, 7],
    );
    expect(x).not.toBeNull();
    expect(x![0]).toBeCloseTo(1, 10);
    expect(x![1]).toBeCloseTo(2, 10);
    expect(x![2]).toBeCloseTo(3, 10);
  });

  it('需要行交换的矩阵（首行主元为 0）', () => {
    // 2y = 4 → y=2；3x + y = 8 → x=2
    const x = solveLinearSystem(
      [
        [0, 2],
        [3, 1],
      ],
      [4, 8],
    );
    expect(x).toEqual([2, 2]);
  });

  it('奇异矩阵 → null（不返回 NaN 数组）', () => {
    expect(
      solveLinearSystem(
        [
          [1, 2],
          [2, 4],
        ],
        [1, 2],
      ),
    ).toBeNull();
  });

  it('形状非法（非方阵/行长度不齐/含 NaN）→ null', () => {
    expect(solveLinearSystem([[1, 2, 3]], [1])).toBeNull();
    expect(solveLinearSystem([[1, 2], [3]], [1, 2])).toBeNull();
    expect(
      solveLinearSystem(
        [
          [1, Number.NaN],
          [3, 4],
        ],
        [1, 2],
      ),
    ).toBeNull();
    expect(
      solveLinearSystem(
        [
          [1, 2],
          [3, 4],
        ],
        [1],
      ),
    ).toBeNull();
  });

  it('量级很小的良态矩阵不被误判奇异（相对阈值回归）', () => {
    // 绝对阈值 1e-12 会把 1e-7 量级的矩阵误判奇异；相对阈值应当通过
    const x = solveLinearSystem(
      [
        [1e-7, 0],
        [0, 2e-7],
      ],
      [1e-7, 4e-7],
    );
    expect(x).not.toBeNull();
    expect(x![0]).toBeCloseTo(1, 10);
    expect(x![1]).toBeCloseTo(2, 10);
  });
});

describe('invertMatrix', () => {
  it('2×2 解析解', () => {
    const inv = invertMatrix([
      [4, 7],
      [2, 6],
    ]);
    expect(inv).not.toBeNull();
    expect(inv![0][0]).toBeCloseTo(0.6, 10); // 6/10
    expect(inv![0][1]).toBeCloseTo(-0.7, 10); // -7/10
    expect(inv![1][0]).toBeCloseTo(-0.2, 10); // -2/10
    expect(inv![1][1]).toBeCloseTo(0.4, 10); // 4/10
  });

  it('A·A⁻¹ ≈ I（随机良态矩阵）', () => {
    const A = [
      [3, 1, 2],
      [1, 4, 0],
      [2, 0, 5],
    ];
    const inv = invertMatrix(A)!;
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        let s = 0;
        for (let k = 0; k < 3; k++) s += A[i][k] * inv[k][j];
        expect(s).toBeCloseTo(i === j ? 1 : 0, 10);
      }
    }
  });

  it('奇异/非方阵 → null', () => {
    expect(
      invertMatrix([
        [1, 2],
        [2, 4],
      ]),
    ).toBeNull();
    expect(invertMatrix([[1, 2, 3]])).toBeNull();
  });
});

describe('olsWithStats', () => {
  it('精确线性关系：系数还原、R²=1、残差≈0', () => {
    const x = [-2, -1, 0, 1, 2, 3];
    const y = x.map((v) => 3 + 2 * v); // y = 3 + 2x
    const r = olsWithStats(y, [x]);
    expect(r.fullRank).toBe(true);
    expect(r.coefficients[0]).toBeCloseTo(3, 10); // 截距
    expect(r.coefficients[1]).toBeCloseTo(2, 10); // 斜率
    expect(r.r2).toBeCloseTo(1, 10);
    for (const e of r.residuals) expect(Math.abs(e)).toBeLessThan(1e-9);
    // 完美拟合：σ̂² = 0 → 标准误为 0（不是 NaN）
    expect(r.stdErrors[0]).toBeCloseTo(0, 10);
  });

  it("含噪数据：标准误为正且与手算 σ̂²(X'X)⁻¹ 一致", () => {
    const x = [1, 2, 3, 4, 5, 6];
    const y = [2.1, 3.9, 6.2, 7.8, 10.1, 12.2];
    const r = olsWithStats(y, [x]);
    expect(r.coefficients[1]).toBeGreaterThan(1);
    expect(r.stdErrors.every((se) => se > 0)).toBe(true);
    expect(r.r2).toBeGreaterThan(0.99);
    // 手算交叉验证：斜率 se = sqrt(σ̂² / Σ(x-x̄)²)
    const n = x.length;
    const xBar = x.reduce((a, b) => a + b, 0) / n;
    const ssr = r.residuals.reduce((a, e) => a + e * e, 0);
    const dof = n - 2;
    const s2 = ssr / dof;
    const sxx = x.reduce((a, v) => a + (v - xBar) ** 2, 0);
    expect(r.stdErrors[1]).toBeCloseTo(Math.sqrt(s2 / sxx), 10);
  });

  it('无截距口径：y = 2x 恰好还原（系数数组不含截距位）', () => {
    const x = [1, 2, 3, 4];
    const y = x.map((v) => 2 * v);
    const r = olsWithStats(y, [x], false);
    expect(r.coefficients).toHaveLength(1);
    expect(r.coefficients[0]).toBeCloseTo(2, 10);
    expect(r.r2).toBeCloseTo(1, 10);
  });

  it('多预测变量：系数与逐列回归一致（正交设计）', () => {
    // 正交列 x1=[-1,-1,1,1], x2=[-1,1,-1,1] → 两个斜率互不干扰
    const x1 = [-1, -1, 1, 1];
    const x2 = [-1, 1, -1, 1];
    const y = x1.map((v, i) => 5 + 3 * v + 2 * x2[i]);
    const r = olsWithStats(y, [x1, x2]);
    expect(r.coefficients[0]).toBeCloseTo(5, 10);
    expect(r.coefficients[1]).toBeCloseTo(3, 10);
    expect(r.coefficients[2]).toBeCloseTo(2, 10);
  });

  it('样本不足（n < p）→ 空结果且 fullRank=false', () => {
    const r = olsWithStats(
      [1, 2],
      [
        [1, 2],
        [3, 4],
      ],
      true,
    );
    expect(r.fullRank).toBe(false);
    expect(r.coefficients).toEqual([0, 0, 0]);
    expect(r.residuals).toEqual([]);
  });

  it('完全共线的预测变量 → 不可逆 → fullRank=false（不输出伪系数）', () => {
    const x1 = [1, 2, 3, 4, 5];
    const x2 = [2, 4, 6, 8, 10]; // 与 x1 完全共线
    const y = [1, 2, 3, 4, 6];
    const r = olsWithStats(y, [x1, x2]);
    expect(r.fullRank).toBe(false);
    expect(r.residuals).toEqual([]);
  });
});

describe('gaussianStream — 确定性高斯噪声', () => {
  it('同 seed 同序列（含 Box-Muller 缓存配对的一致性）', () => {
    const a = gaussianStream(42);
    const b = gaussianStream(42);
    const seqA = Array.from({ length: 10 }, () => a());
    const seqB = Array.from({ length: 10 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it('均值≈0、标准差≈1（大样本统计特性）', () => {
    const g = gaussianStream(7);
    const n = 20000;
    const xs = Array.from({ length: n }, () => g());
    const mean = xs.reduce((a, v) => a + v, 0) / n;
    const sd = Math.sqrt(xs.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1));
    expect(Math.abs(mean)).toBeLessThan(0.03);
    expect(sd).toBeGreaterThan(0.95);
    expect(sd).toBeLessThan(1.05);
    // 无 NaN/Infinity（u1 夹紧到 1e-12 防 log(0) 的分支）
    expect(xs.every((v) => Number.isFinite(v))).toBe(true);
  });
});
