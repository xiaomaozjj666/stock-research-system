import { describe, it, expect } from 'vitest';
import {
  meanReversionComponent,
  expectedForwardReturn,
  expectedForwardReturnFromData,
  scenarioProbabilities,
  targetPriceRange,
  validatePredictionModel,
  backtestNewsImpact,
  type PredictionValidationRow,
  type NewsBacktestRow,
} from '../predictionModel.js';
import type { FinancialData, ValuationData, StockInfo } from '../../types.js';

function makeFinancial(overrides: Partial<FinancialData> = {}): FinancialData {
  const years = ['2020', '2021', '2022', '2023', '2024', '2025'];
  const base: FinancialData = {
    years,
    revenue: [100, 120, 140, 160, 180, 200],
    netProfit: [30, 36, 42, 48, 54, 60],
    grossMargin: [90, 90, 90, 90, 90, 90],
    netMargin: [30, 30, 30, 30, 30, 30],
    roe: [30, 30, 30, 30, 30, 30],
    operatingCashFlow: [35, 40, 45, 50, 55, 60],
    eps: [1, 1.2, 1.4, 1.6, 1.8, 2],
    totalAssets: [500, 520, 540, 560, 580, 600],
    totalLiabilities: [150, 155, 160, 165, 170, 175],
    equity: [350, 365, 380, 395, 410, 425],
    accountsReceivable: [5, 5, 5, 5, 5, 5],
    inventory: [20, 20, 20, 20, 20, 20],
    goodwill: [0, 0, 0, 0, 0, 0],
    debtRatio: [30, 30, 30, 30, 30, 30],
  };
  return { ...base, ...overrides };
}

const valuation: ValuationData = {
  currentPrice: 100,
  pe: 20,
  pb: 5,
  ps: 8,
  marketCap: 2000,
  historicalPE: [
    { year: '2021', pe: 25 }, { year: '2022', pe: 24 }, { year: '2023', pe: 23 },
    { year: '2024', pe: 22 }, { year: '2025', pe: 21 }, { year: '2026', pe: 20 },
  ],
  peerComparison: [],
};
const info: StockInfo = { code: '600519', name: '测试股', industry: '白酒', market: '上交所主板', listingDate: '', description: '' };

describe('meanReversionComponent', () => {
  it('低估(分位<50)为正，高估(分位>50)为负', () => {
    expect(meanReversionComponent(10)).toBeGreaterThan(0);
    expect(meanReversionComponent(90)).toBeLessThan(0);
    expect(meanReversionComponent(50)).toBeCloseTo(0, 6);
  });
  it('夹紧到 [-0.3, 0.3]', () => {
    expect(meanReversionComponent(0)).toBeLessThanOrEqual(0.3);
    expect(meanReversionComponent(100)).toBeGreaterThanOrEqual(-0.3);
  });
});

describe('expectedForwardReturn', () => {
  it('优质因子(全正z)给出正期望收益', () => {
    const z: Record<string, number> = { a: 1, b: 0.5, c: 0.8 };
    const r = expectedForwardReturn({ zByFactor: z, pePercentile: 20, weights: { a: 1, b: 1, c: 1 } });
    expect(r.expectedReturn).toBeGreaterThan(0);
    expect(r.factorComponent).toBeGreaterThan(0);
    expect(r.meanReversion).toBeGreaterThan(0);
  });
  it('劣质因子(全负z) + 高估值给出负期望收益', () => {
    const z: Record<string, number> = { a: -1, b: -0.5, c: -0.8 };
    const r = expectedForwardReturn({ zByFactor: z, pePercentile: 90 });
    expect(r.expectedReturn).toBeLessThan(0);
  });
  it('期望收益夹紧到 [-0.5, 0.8]', () => {
    const r = expectedForwardReturn({ zByFactor: { a: 100 }, pePercentile: 0 });
    expect(r.expectedReturn).toBeLessThanOrEqual(0.8);
    const r2 = expectedForwardReturn({ zByFactor: { a: -100 }, pePercentile: 100 });
    expect(r2.expectedReturn).toBeGreaterThanOrEqual(-0.5);
  });
  it('未提供权重时退化为等权，因子仍参与组合（factorComponent 非零）', () => {
    // 回归：之前空权重导致 compositeZ 返回 0、因子贡献归零
    const r = expectedForwardReturn({ zByFactor: { a: 1, b: 0.8, c: 0.6 }, pePercentile: 50 });
    expect(r.factorComponent).toBeGreaterThan(0);
    expect(r.expectedReturn).toBeGreaterThan(0);
  });
  it('从财务数据直接估算期望收益（不低于边界）', () => {
    const r = expectedForwardReturnFromData(makeFinancial(), valuation, info);
    expect(r.expectedReturn).toBeGreaterThanOrEqual(-0.5);
    expect(r.expectedReturn).toBeLessThanOrEqual(0.8);
  });
  it('newsZ 为正（利好新闻）抬高期望收益，为负（利空）压低', () => {
    const base = { zByFactor: { a: 0.5, b: 0.3 }, pePercentile: 50 };
    const r0 = expectedForwardReturn({ ...base });
    const rPos = expectedForwardReturn({ ...base, newsZ: 1 });
    const rNeg = expectedForwardReturn({ ...base, newsZ: -1 });
    expect(rPos.expectedReturn).toBeGreaterThan(r0.expectedReturn);
    expect(rNeg.expectedReturn).toBeLessThan(r0.expectedReturn);
    expect(rPos.newsComponent).toBeGreaterThan(0);
    expect(rNeg.newsComponent).toBeLessThan(0);
  });
  it('newsZ=0 时 newsComponent 为 0，不影响纯量化结果', () => {
    const r = expectedForwardReturn({ zByFactor: { a: 1 }, pePercentile: 50, newsZ: 0 });
    expect(r.newsComponent).toBe(0);
  });
});

describe('scenarioProbabilities + 新闻微调', () => {
  it('叠加利好新闻微调使乐观概率更高', () => {
    const base = scenarioProbabilities(0.1, 40);
    const withNews = scenarioProbabilities(0.1, 40, 0, 0.8);
    expect(withNews.optimistic).toBeGreaterThan(base.optimistic);
  });
  it('叠加利空新闻微调使悲观概率更高', () => {
    const base = scenarioProbabilities(0.1, 40);
    const withNews = scenarioProbabilities(0.1, 40, 0, -0.8);
    expect(withNews.pessimistic).toBeGreaterThan(base.pessimistic);
  });
  it('新闻微调后概率仍和为 1 且 ∈ [0,1]', () => {
    const p = scenarioProbabilities(0.2, 30, 0.1, -0.6);
    const sum = p.optimistic + p.neutral + p.pessimistic;
    expect(sum).toBeCloseTo(1, 6);
  });
});

describe('scenarioProbabilities', () => {
  it('概率始终和为 1 且各 ∈ [0,1]', () => {
    for (const [er, pct] of [[0.3, 10], [-0.3, 90], [0, 50], [0.1, 40]] as const) {
      const p = scenarioProbabilities(er, pct);
      const sum = p.optimistic + p.neutral + p.pessimistic;
      expect(sum).toBeCloseTo(1, 6);
      for (const v of Object.values(p)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });
  it('偏多情景下乐观概率高于悲观', () => {
    const p = scenarioProbabilities(0.3, 10);
    expect(p.optimistic).toBeGreaterThan(p.pessimistic);
  });
  it('偏空情景下悲观概率高于乐观', () => {
    const p = scenarioProbabilities(-0.3, 90);
    expect(p.pessimistic).toBeGreaterThan(p.optimistic);
  });
});

describe('targetPriceRange', () => {
  it('期望价为当前价×(1+E[r])，区间对称包络', () => {
    const { low, high } = targetPriceRange(100, 0.2);
    const expected = 100 * 1.2;
    expect(Math.abs((low + high) / 2 - expected)).toBeLessThanOrEqual(expected * 0.25 + 1);
    expect(high).toBeGreaterThan(low);
    expect(low).toBeGreaterThan(0);
  });
  it('负期望收益时目标价低于当前价', () => {
    const { low, high } = targetPriceRange(100, -0.2);
    expect(high).toBeLessThanOrEqual(100);
    // 期望目标价中点 = 100×0.8 = 80 < 100
    expect((low + high) / 2).toBeLessThan(100);
  });
});

describe('validatePredictionModel', () => {
  // 面板：因子A与收益正相关，低估(低分位)对应正收益
  const panel: PredictionValidationRow[] = [
    { factors: { A: 5, B: 1 }, pePercentile: 10, forwardReturn: 0.30 },
    { factors: { A: 4, B: 9 }, pePercentile: 20, forwardReturn: 0.20 },
    { factors: { A: 3, B: 3 }, pePercentile: 50, forwardReturn: 0.05 },
    { factors: { A: 2, B: 7 }, pePercentile: 80, forwardReturn: -0.15 },
    { factors: { A: 1, B: 2 }, pePercentile: 90, forwardReturn: -0.25 },
  ];
  it('方向准确率 ∈ [0,1]，RMSE ≥ 0', () => {
    const rep = validatePredictionModel(panel);
    expect(rep.n).toBe(5);
    expect(rep.directionalAccuracy).toBeGreaterThanOrEqual(0);
    expect(rep.directionalAccuracy).toBeLessThanOrEqual(1);
    expect(rep.rmse).toBeGreaterThanOrEqual(0);
  });
  it('样本不足返回空报告', () => {
    const rep = validatePredictionModel(panel.slice(0, 2));
    expect(rep.n).toBe(2);
    expect(rep.directionalAccuracy).toBe(0);
  });
});

describe('backtestNewsImpact（根据最新消息进行回测）', () => {
  // 面板：因子A与收益正相关；newsZ 与收益同号（利好新闻对应正收益）
  const panel: NewsBacktestRow[] = [
    { factors: { A: 5, B: 1 }, pePercentile: 10, forwardReturn: 0.30, newsZ: 1.2 },
    { factors: { A: 4, B: 9 }, pePercentile: 20, forwardReturn: 0.20, newsZ: 0.8 },
    { factors: { A: 3, B: 3 }, pePercentile: 50, forwardReturn: 0.05, newsZ: 0.1 },
    { factors: { A: 2, B: 7 }, pePercentile: 80, forwardReturn: -0.15, newsZ: -0.9 },
    { factors: { A: 1, B: 2 }, pePercentile: 90, forwardReturn: -0.25, newsZ: -1.3 },
  ];
  it('含新闻的方向准确率不低于不含新闻（新闻同向于收益）', () => {
    const rep = backtestNewsImpact(panel);
    expect(rep.n).toBe(5);
    expect(rep.withNews.directionalAccuracy).toBeGreaterThanOrEqual(rep.baseline.directionalAccuracy);
    expect(rep.deltaAccuracy).toBeGreaterThanOrEqual(0);
  });
  it('newsIC 与新闻-收益同向时为正', () => {
    const rep = backtestNewsImpact(panel);
    expect(rep.newsIC).toBeGreaterThan(0);
  });
  it('反向新闻（与收益负相关）应给出负 IC，同向新闻给出正 IC', () => {
    const noisy: NewsBacktestRow[] = panel.map((r) => ({ ...r, newsZ: -(r.newsZ ?? 0) }));
    const origIC = backtestNewsImpact(panel).newsIC;
    const noisyIC = backtestNewsImpact(noisy).newsIC;
    expect(origIC).toBeGreaterThan(0);
    expect(noisyIC).toBeLessThan(0);
  });
  it('样本不足返回中性报告', () => {
    const rep = backtestNewsImpact(panel.slice(0, 2));
    expect(rep.n).toBe(2);
    expect(rep.deltaAccuracy).toBe(0);
  });
});
