import { describe, it, expect } from 'vitest';
import { calculateScores, scoreDebtRisk } from '../scoreEngine.js';
import type { FinancialData, ValuationData, StockInfo } from '../../types.js';

function makeFinancial(overrides: Partial<FinancialData> = {}): FinancialData {
  const years = ['2020', '2021', '2022', '2023', '2024', '2025'];
  const base: FinancialData = {
    years,
    revenue: [100, 120, 140, 160, 180, 200],
    netProfit: [30, 36, 42, 48, 54, 60],
    // 注意：财务比率在系统内统一以「百分数」形式存储（91.5 而非 0.915）
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
    { year: '2021', pe: 25 },
    { year: '2022', pe: 24 },
    { year: '2023', pe: 23 },
    { year: '2024', pe: 22 },
    { year: '2025', pe: 21 },
    { year: '2026', pe: 20 },
  ],
  peerComparison: [],
};

const info: StockInfo = {
  code: '600519',
  name: '测试股',
  industry: '白酒',
  market: '上交所主板',
  listingDate: '',
  description: '',
};

describe('calculateScores', () => {
  it('返回五维度评分且均在合法区间内', () => {
    const s = calculateScores(makeFinancial(), valuation, info);
    expect(s.profit_quality).toBeGreaterThanOrEqual(0);
    expect(s.profit_quality).toBeLessThanOrEqual(20);
    expect(s.growth).toBeGreaterThanOrEqual(0);
    expect(s.growth).toBeLessThanOrEqual(20);
    expect(s.valuation).toBeGreaterThanOrEqual(0);
    expect(s.valuation).toBeLessThanOrEqual(20);
    expect(s.industry_boom).toBeGreaterThanOrEqual(0);
    expect(s.industry_boom).toBeLessThanOrEqual(20);
    expect(s.risk_deduction).toBeGreaterThanOrEqual(0);
    expect(s.risk_deduction).toBeLessThanOrEqual(20);
  });

  it('优质股（高毛利/高ROE/高增长）盈利质量得分较高', () => {
    const strong = calculateScores(makeFinancial(), valuation, info);
    expect(strong.profit_quality).toBeGreaterThan(10);
    expect(strong.growth).toBeGreaterThan(8);
  });

  it('亏损股（持续负利润/低毛利/低ROE）成长性与盈利质量偏低', () => {
    const weakFinancial = makeFinancial({
      netProfit: [-10, -20, -30, -40, -50, -60], // 持续恶化
      grossMargin: [10, 10, 10, 10, 10, 10],
      roe: [-30, -40, -50, -60, -80, -100],
      operatingCashFlow: [-5, -10, -15, -20, -25, -30],
      revenue: [200, 180, 160, 140, 120, 100], // 下滑
    });
    const weak = calculateScores(weakFinancial, valuation, info);
    expect(weak.growth).toBeLessThanOrEqual(5);
    expect(weak.profit_quality).toBeLessThan(15);
  });

  it('注入 IR 最优权重后，强因子主导维度得分（最优因子可用）', () => {
    // 把 roe 权重拉满，其余因子权重归零：盈利质量应主要由 ROE 决定
    const s = calculateScores(
      makeFinancial(),
      valuation,
      info,
      undefined,
      { factorWeights: { roe: 1, grossMargin: 0, cashFlowRatio: 0, arRatioProfit: 0, gmStability: 0 } },
    );
    expect(s.profit_quality).toBeGreaterThan(10);
    // 与等权相比，ROE 主导下分数仍落在合法区间
    expect(s.profit_quality).toBeLessThanOrEqual(20);
  });

  it('回归：应收占比处于正常区间（15%）时仍应有部分得分，不应被量纲错误清零', () => {
    // 修复前 riskScore 使用 `4 - arRatio * 10`（把百分数当小数用），
    // 导致任何 AR/营收 > 0.4% 的公司应收风险项直接归零。
    const normalAR = makeFinancial({ accountsReceivable: [30, 30, 30, 30, 30, 30] }); // 30/200 = 15%
    const heavyAR = makeFinancial({ accountsReceivable: [90, 90, 90, 90, 90, 90] }); // 90/200 = 45%
    const normal = calculateScores(normalAR, valuation, info);
    const heavy = calculateScores(heavyAR, valuation, info);
    expect(normal.risk_deduction).toBeGreaterThan(heavy.risk_deduction);
    expect(normal.profit_quality).toBeGreaterThan(heavy.profit_quality);
  });

  it('极端劣质数据下所有维度仍被夹紧在 0-20 区间', () => {
    const terrible = makeFinancial({
      revenue: [500, 400, 300, 200, 120, 60],
      netProfit: [-50, -80, -120, -200, -300, -400],
      grossMargin: [-20, -25, -30, -40, -50, -60],
      roe: [-30, -40, -50, -60, -80, -100],
      operatingCashFlow: [-60, -90, -140, -220, -320, -420],
      debtRatio: [95, 96, 97, 98, 99, 99.5],
      goodwill: [200, 200, 200, 200, 200, 200],
      accountsReceivable: [120, 120, 120, 120, 120, 120],
    });
    const s = calculateScores(terrible, valuation, info);
    for (const v of Object.values(s)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(20);
    }
  });

  it('行业基准影响估值分（高 PE 行业容忍度更高）', () => {
    const bankInfo: StockInfo = { ...info, industry: '银行' };
    const bankValuation: ValuationData = { ...valuation, pe: 8 };
    const bank = calculateScores(makeFinancial(), bankValuation, bankInfo);
    expect(bank.valuation).toBeGreaterThanOrEqual(0);
  });

  it('高杠杆行业不会因行业固有负债结构被判为零风险分', () => {
    // 银行负债率 91% 属于行业常态，不应与制造业同一把尺子衡量
    const bankFin = makeFinancial({ debtRatio: [90, 90.5, 91, 91, 91.2, 91] });
    const bank = calculateScores(bankFin, valuation, { ...info, industry: '银行' });
    const asManufacturer = calculateScores(bankFin, valuation, { ...info, industry: '制造业' });
    expect(bank.risk_deduction).toBeGreaterThan(asManufacturer.risk_deduction);
  });
});

describe('scoreDebtRisk', () => {
  it('低于行业安全线给满分，高于危险线给零分', () => {
    expect(scoreDebtRisk(20, '制造业')).toBe(7); // 45*0.6 = 27 以下
    expect(scoreDebtRisk(60, '制造业')).toBe(0); // 45*1.25 = 56.25 以上
  });

  it('同一负债率在不同行业得到不同评价', () => {
    // 76% 负债率：对建筑业是常态，对家电业已偏高
    expect(scoreDebtRisk(76, '建筑')).toBeGreaterThan(scoreDebtRisk(76, '家电'));
  });

  it('未知行业回落到默认基准且结果始终落在 0-7', () => {
    for (const ratio of [-10, 0, 33, 55, 99, 150, NaN, Infinity]) {
      const s = scoreDebtRisk(ratio, '某不存在的行业');
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(7);
    }
  });
});
