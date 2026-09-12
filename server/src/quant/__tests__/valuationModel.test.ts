/**
 * 估值建模测试：DCF 手工算例对照、发散校验、敏感性矩阵、可比表、自动推导。
 * 纯函数模块，无 IO、无 mock。
 */
import { describe, it, expect } from 'vitest';
import {
  twoStageEpsDcf,
  sensitivityMatrix,
  buildComparableAnalysis,
  epsCagr,
  runValuationModel,
} from '../valuationModel.js';
import type { FinancialData, ValuationData } from '../../types.js';

describe('twoStageEpsDcf — 数学正确性', () => {
  it('零增长基准：base=1, g1=0, g2=0, r=10%, 5 年 → 公允价值恰为 10', () => {
    const r = twoStageEpsDcf({
      baseEps: 1,
      growthRate1: 0,
      growthRate2: 0,
      discountRate: 0.1,
      explicitYears: 5,
    });
    // Σ 1/1.1^t = 3.7908；终值 1/0.1=10 折现 10/1.1^5=6.2092
    expect(r.explicitValue).toBeCloseTo(3.79, 2);
    expect(r.discountedTerminalValue).toBeCloseTo(6.21, 2);
    expect(r.fairValue).toBeCloseTo(10, 2);
    expect(r.cashFlows).toHaveLength(5);
    expect(r.cashFlows[0].eps).toBeCloseTo(1, 6);
  });

  it('增长算例：base=1, g1=10%, g2=3%, r=9%, 5 年 → 与手工计算一致', () => {
    const r = twoStageEpsDcf({
      baseEps: 1,
      growthRate1: 0.1,
      growthRate2: 0.03,
      discountRate: 0.09,
      explicitYears: 5,
    });
    // Σ eps_t/1.09^t ≈ 5.139；TV = 1.61051*1.03/0.06 ≈ 27.65，折现 ≈ 17.97
    expect(r.explicitValue).toBeCloseTo(5.14, 2);
    expect(r.discountedTerminalValue).toBeCloseTo(17.97, 2);
    expect(r.fairValue).toBeCloseTo(23.11, 2);
  });

  it('g2 ≥ r → 抛错（终值发散，绝不输出天文数字）', () => {
    for (const [g2, r2] of [
      [0.09, 0.09],
      [0.1, 0.09],
    ] as const) {
      expect(() =>
        twoStageEpsDcf({
          baseEps: 1,
          growthRate1: 0.1,
          growthRate2: g2,
          discountRate: r2,
          explicitYears: 5,
        }),
      ).toThrow(/严格小于/);
    }
  });

  it('非法参数（非正 EPS / 非正折现率 / 年数越界）逐项抛错', () => {
    const base = {
      baseEps: 1,
      growthRate1: 0.1,
      growthRate2: 0.03,
      discountRate: 0.09,
      explicitYears: 5,
    };
    expect(() => twoStageEpsDcf({ ...base, baseEps: 0 })).toThrow('baseEps');
    expect(() => twoStageEpsDcf({ ...base, discountRate: 0 })).toThrow('discountRate');
    expect(() => twoStageEpsDcf({ ...base, explicitYears: 0 })).toThrow('explicitYears');
    expect(() => twoStageEpsDcf({ ...base, explicitYears: 16 })).toThrow('explicitYears');
  });
});

describe('sensitivityMatrix — 网格', () => {
  it('逐格独立计算；低折现率 × 高 g2 的格子如实 NaN', () => {
    const m = sensitivityMatrix(1, [0.02, 0.09], [0.05, 0.1], 0.03, 5);
    expect(m.discountRates).toEqual([0.02, 0.09]);
    expect(m.growthRates1).toEqual([0.05, 0.1]);
    // r=0.02 < g2=0.03 → 整行 NaN
    expect(m.matrix[0]).toEqual([NaN, NaN]);
    // r=0.09 行全部可算，且高增速格价值更高
    expect(m.matrix[1][0]).toBeGreaterThan(0);
    expect(m.matrix[1][1]).toBeGreaterThan(m.matrix[1][0]);
  });
});

describe('buildComparableAnalysis — 可比表', () => {
  const peers = [
    { name: '甲', code: '600001', pe: 20, pb: 2.5, roe: 15, marketCap: 1000 },
    { name: '乙', code: '600002', pe: 30, pb: 3.0, roe: 18, marketCap: 800 },
    { name: '丙', code: '600003', pe: -5, pb: 0.8, roe: -3, marketCap: 200 }, // 负 PE 过滤
    { name: '丁', code: '600004', pe: 40, pb: 3.5, roe: 20, marketCap: 600 },
  ];

  it('过滤非正估值后取中位数，计算本股折溢价与隐含价值', () => {
    const a = buildComparableAnalysis(
      { code: '600519', name: '本股', pe: 24, pb: 4, roe: 30, eps: 10 },
      peers,
    );
    expect(a.sampleSize).toBe(3);
    expect(a.medianPe).toBe(30);
    expect(a.medianPb).toBe(3);
    expect(a.medianRoe).toBe(18);
    expect(a.pePremiumPct).toBeCloseTo(-0.2, 3); // 24/30 - 1
    expect(a.pbPremiumPct).toBeCloseTo(4 / 3 - 1, 3);
    expect(a.impliedValueByMedianPe).toBe(300); // 30 × 10
  });

  it('样本全被过滤 → 中位数为 null，不硬凑', () => {
    const a = buildComparableAnalysis(
      { code: '600519', name: '本股', pe: 24, pb: 4, roe: 30, eps: 10 },
      [peers[2]],
    );
    expect(a.sampleSize).toBe(0);
    expect(a.medianPe).toBeNull();
    expect(a.pePremiumPct).toBeNull();
    expect(a.impliedValueByMedianPe).toBeNull();
  });
});

describe('epsCagr — 首尾法复合增速（取最近 years+1 个有效点）', () => {
  it('正常序列：最近窗口首尾复合', () => {
    expect(epsCagr([1, 2, 3, 4, 8], 3)).toBeCloseTo((8 / 2) ** (1 / 3) - 1, 4);
    expect(epsCagr([5, 4, 3, 2, 1], 3)).toBeCloseTo((1 / 4) ** (1 / 3) - 1, 4); // 窗口 [4,3,2,1]
  });

  it('样本不足（< years+1 个有效值）→ null；中间的非正值不改变窗口取点', () => {
    expect(epsCagr([1, 2], 3)).toBeNull();
    expect(epsCagr([1, 0, 3, 4, 5], 3)).toBeCloseTo((5 / 1) ** (1 / 3) - 1, 4);
  });
});

describe('runValuationModel — 组合入口', () => {
  const financial: FinancialData = {
    years: ['2021', '2022', '2023', '2024'],
    revenue: [100, 110, 121, 133],
    netProfit: [10, 11, 12, 13],
    grossMargin: [50, 51, 52, 53],
    netMargin: [10, 10, 10, 10],
    roe: [12, 13, 14, 15],
    operatingCashFlow: [12, 13, 14, 15],
    eps: [1, 1.1, 1.21, 1.331],
    totalAssets: [100, 105, 110, 115],
    totalLiabilities: [40, 42, 44, 46],
    equity: [60, 63, 66, 69],
    accountsReceivable: [5, 6, 7, 8],
    inventory: [3, 3, 4, 4],
    goodwill: [0, 0, 0, 0],
    debtRatio: [40, 40, 40, 40],
  };
  const valuation: ValuationData = {
    currentPrice: 20,
    pe: 15,
    pb: 4,
    ps: 3,
    marketCap: 2600,
    historicalPE: [{ year: '2024', pe: 15 }],
    peerComparison: [
      { name: '甲', code: '600001', pe: 20, pb: 2.5, roe: 15, marketCap: 1000 },
      { name: '乙', code: '600002', pe: 30, pb: 3, roe: 18, marketCap: 800 },
      { name: '丙', code: '600003', pe: 40, pb: 3.5, roe: 20, marketCap: 600 },
    ],
  };

  it('自动推导：baseEps=1.331，g1=EPS 3 年 CAGR≈0.1，DCF 可执行且敏感性矩阵齐备', () => {
    const r = runValuationModel('600519', financial, valuation);
    expect(r.assumptions.baseEps).toBeCloseTo(1.331, 6);
    expect(r.assumptions.growthRate1Source).toBe('eps_cagr_3y');
    expect(r.assumptions.growthRate1).toBeCloseTo(0.1, 6); // (1.331/1)^(1/3)-1
    expect(r.dcf).not.toBeNull();
    expect(r.sensitivity).not.toBeNull();
    expect(r.upsidePct).not.toBeNull();
    expect(r.comparables.sampleSize).toBe(3);
    // 局限声明始终随结果返回
    expect(r.limitations.some((l) => l.includes('EPS 贴现近似'))).toBe(true);
  });

  it('EPS 缺失 → dcf=null 如实披露，可比表仍返回', () => {
    const noEps: FinancialData = { ...financial, eps: [0, 0, 0, 0] };
    const r = runValuationModel('600519', noEps, valuation);
    expect(r.dcf).toBeNull();
    expect(r.fairValue).toBeNull();
    expect(r.upsidePct).toBeNull();
    expect(r.limitations.some((l) => l.includes('DCF 不可执行'))).toBe(true);
    expect(r.comparables.sampleSize).toBe(3);
  });

  it('显式覆盖假设：输入优先于推导；可比样本不足时 limitation 提示', () => {
    const r = runValuationModel(
      '600519',
      financial,
      { ...valuation, peerComparison: [] },
      {
        growthRate1: 0.15,
        discountRate: 0.1,
        explicitYears: 5,
        growthRate2: 0.03,
      },
    );
    expect(r.assumptions.growthRate1Source).toBe('input');
    expect(r.assumptions.growthRate1).toBe(0.15);
    expect(r.limitations.some((l) => l.includes('可比样本仅 0 个'))).toBe(true);
  });
});
