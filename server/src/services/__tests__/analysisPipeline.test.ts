import { describe, it, expect, vi } from 'vitest';
import { runAnalysis } from '../analysisPipeline.js';
import type { StockDataSet, FinancialData, ValuationData, StockInfo } from '../../types.js';

// 用可控的样例数据替掉真实的网络数据获取，验证流水线装配正确性
const sampleFinancial: FinancialData = {
  years: ['2021', '2022', '2023', '2024', '2025', '2026'],
  revenue: [100, 120, 150, 180, 220, 260],
  netProfit: [20, 25, 30, 35, 40, 50],
  grossMargin: [90, 91, 92, 91, 90, 91],
  netMargin: [20, 21, 20, 19, 18, 19],
  roe: [25, 26, 27, 26, 25, 26],
  operatingCashFlow: [22, 27, 32, 37, 42, 52],
  eps: [1, 1.2, 1.5, 1.7, 2, 2.5],
  totalAssets: [500, 550, 600, 650, 700, 800],
  totalLiabilities: [100, 110, 120, 130, 140, 150],
  equity: [400, 440, 480, 520, 560, 650],
  accountsReceivable: [5, 6, 7, 8, 9, 10],
  inventory: [10, 12, 14, 16, 18, 20],
  goodwill: [0, 0, 0, 0, 0, 0],
  debtRatio: [20, 20, 20, 20, 20, 19],
  dataQuality: { estimatedFields: [], missingFields: ['goodwill'] },
};

const sampleValuation: ValuationData = {
  currentPrice: 1800,
  pe: 30,
  pb: 6,
  ps: 10,
  marketCap: 22600,
  historicalPE: [{ year: '2026', pe: 30, isEstimated: false }],
  peerComparison: [{ name: '五粮液', code: '000858', pe: 20, pb: 5, roe: 25, marketCap: 5000 }],
};

const sampleInfo: StockInfo = {
  code: '600519',
  name: '贵州茅台',
  industry: '白酒',
  market: '上交所主板',
  listingDate: '',
  description: '',
};

const sampleData: StockDataSet = { info: sampleInfo, financial: sampleFinancial, valuation: sampleValuation };

vi.mock('../dataService.js', () => ({
  getData: vi.fn(async () => sampleData),
}));

vi.mock('../../quant/dataProvider.js', () => ({
  fetchOHLCVData: vi.fn(async () => []), // 无K线 -> 策略清单为空，不触发网络
}));

describe('runAnalysis 流水线', () => {
  it('装配出结构合法的分析结果', async () => {
    const result = await runAnalysis('600519');
    const stock = result.stock_pool[0];

    // 基本字段
    expect(stock.stock_code).toBe('600519');
    expect(stock.stock_name).toBe('贵州茅台');
    expect(stock.industry).toBe('白酒');

    // 评分五维之和为总分
    const sd = stock.score_detail;
    const sum = sd.profit_quality + sd.growth + sd.valuation + sd.industry_boom + sd.risk_deduction;
    expect(sum).toBe(stock.total_score);
    expect(stock.total_score).toBeGreaterThanOrEqual(0);
    expect(stock.total_score).toBeLessThanOrEqual(100);

    // 评级在枚举内
    expect(['优先跟踪', '持续观察', '谨慎观望', '建议规避']).toContain(stock.rating);

    // 五位专家 + 仲裁 = 至少 6 条观点
    expect(stock.expert_opinions.length).toBeGreaterThanOrEqual(6);

    // PE 已基于 股价/eps 修正
    expect(stock.valuation.pe).toBeCloseTo(1800 / 2.5, 1);

    // 历史 PE 含 6 年
    expect(stock.valuation.historicalPE.length).toBe(6);

    // 自省/跟踪/数据来源均有内容
    expect(stock.reflection_notes.length).toBeGreaterThan(0);
    expect(stock.follow_up_indicators.length).toBeGreaterThan(0);
    expect(result.data_sources.length).toBeGreaterThan(0);

    // 量化策略在无K线时为空数组（不崩溃）
    expect(Array.isArray(stock.strategyList)).toBe(true);
  });

  it('核心摘要包含公司名与评级', async () => {
    const result = await runAnalysis('600519');
    expect(result.stock_pool[0].core_summary).toContain('贵州茅台');
    expect(result.stock_pool[0].core_summary).toContain(result.stock_pool[0].rating);
  });

  it('不同财务特征产生不同评分（高杠杆低毛利得分更低）', async () => {
    const weakData: StockDataSet = {
      ...sampleData,
      financial: {
        ...sampleFinancial,
        grossMargin: [10, 10, 10, 10, 10, 10],
        netMargin: [2, 2, 2, 2, 2, 2],
        roe: [3, 3, 3, 3, 3, 3],
        debtRatio: [85, 86, 87, 88, 89, 90],
        totalLiabilities: [850, 860, 870, 880, 890, 900],
        equity: [150, 140, 130, 120, 110, 100],
      },
    };
    const { getData } = await import('../dataService.js');
    vi.mocked(getData).mockImplementation(async () => weakData);

    const weak = await runAnalysis('601668');
    expect(weak.stock_pool[0].total_score).toBeLessThan(100);
    // 高杠杆应拉低风险维度
    expect(weak.stock_pool[0].score_detail.risk_deduction).toBeLessThan(20);
  });
});
