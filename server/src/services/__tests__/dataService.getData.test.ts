import { describe, it, expect, vi, beforeEach } from 'vitest';

// 隔离 fs（避免真实写入缓存目录）与网络数据源，专注验证 getData 的编排逻辑：
// 命名规范化、行业解析、同业填充、样本降级、异常抛出、支持列表组装。
vi.mock('fs', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    promises: {
      ...actual.promises,
      readFile: vi.fn(async () => { throw new Error('no cache'); }),
      writeFile: vi.fn(async () => {}),
      readdir: vi.fn(async () => []),
    },
  };
});

vi.mock('../dataFetcher.js', () => ({
  fetchStockInfo: vi.fn(),
  fetchFinancialData: vi.fn(),
  fetchValuationData: vi.fn(),
}));
vi.mock('../peerService.js', () => ({
  resolveStockIndustry: vi.fn(async () => '半导体'),
  buildPeerComparison: vi.fn(async () => []),
}));
vi.mock('../../data/sampleData.js', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const actual = (await importOriginal()) as any;
  return actual;
});

import { getData, getSupportedStocks } from '../dataService.js';
import { fetchStockInfo, fetchFinancialData, fetchValuationData } from '../dataFetcher.js';
import { resolveStockIndustry, buildPeerComparison } from '../peerService.js';
import { MOUTAI_INFO } from '../../data/sampleData.js';

const mockFetchInfo = vi.mocked(fetchStockInfo);
const mockFetchFinancial = vi.mocked(fetchFinancialData);
const mockFetchValuation = vi.mocked(fetchValuationData);
const mockResolveIndustry = vi.mocked(resolveStockIndustry);
const mockBuildPeers = vi.mocked(buildPeerComparison);

function okFinancial() {
  return {
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
    dataQuality: { estimatedFields: [], missingFields: [] },
  };
}
function okValuation() {
  return {
    currentPrice: 1800,
    pe: 30,
    pb: 6,
    ps: 10,
    marketCap: 22600,
    historicalPE: [{ year: '2026', pe: 30, isEstimated: false }],
    peerComparison: [],
  };
}

describe('getData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('正常装配：规范化窗口名 + 解析行业 + 填充同业对比', async () => {
    mockFetchInfo.mockResolvedValue({ code: '688825', name: 'C长鑫', industry: '半导体', market: '上交所', listingDate: '', description: '' });
    mockFetchFinancial.mockResolvedValue(okFinancial());
    mockFetchValuation.mockResolvedValue(okValuation());
    mockResolveIndustry.mockResolvedValue('半导体');
    mockBuildPeers.mockResolvedValue([{ name: '中芯国际', code: '688981', pe: 50, pb: 5, roe: 0, marketCap: 3000 }]);

    const ds = await getData('688825');
    // 上市窗口名 C 前缀被规范化去除
    expect(ds.info.name).toBe('长鑫科技');
    expect(ds.info.industry).toBe('半导体');
    // 同业对比由 buildPeerComparison 注入
    expect(ds.valuation.peerComparison).toHaveLength(1);
    expect(ds.valuation.peerComparison[0].code).toBe('688981');
  });

  it('主数据不可达且为茅台时降级到内置样本', async () => {
    mockFetchInfo.mockRejectedValue(new Error('upstream down'));
    const ds = await getData('600519');
    expect(ds.info.code).toBe('600519');
    expect(ds.info.name).toBe(MOUTAI_INFO.name);
  });

  it('非茅台标的主数据失败时抛出明确错误', async () => {
    mockFetchInfo.mockRejectedValue(new Error('upstream down'));
    await expect(getData('999999')).rejects.toThrow(/无法获取股票数据/);
  });
});

describe('getSupportedStocks', () => {
  it('无缓存时至少包含茅台', async () => {
    const stocks = await getSupportedStocks();
    expect(stocks.find(s => s.code === '600519')).toMatchObject({ name: '贵州茅台', industry: '白酒' });
  });
});
