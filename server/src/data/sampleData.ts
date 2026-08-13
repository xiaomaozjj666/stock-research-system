import type { StockInfo, FinancialData, ValuationData } from '../types.js';

export const MOUTAI_INFO: StockInfo = {
  code: '600519',
  name: '贵州茅台',
  industry: '白酒',
  market: '上交所主板',
  listingDate: '2001-08-27',
  description:
    '中国高端白酒龙头企业，主营茅台酒及系列酒的生产与销售。公司拥有独特的酿造工艺和不可复制的地理环境优势，产品以酱香型白酒为核心，在高端白酒市场占据绝对主导地位。',
};

export const MOUTAI_FINANCIAL: FinancialData = {
  years: ['2019', '2020', '2021', '2022', '2023', '2024'],
  revenue: [888.5, 979.9, 1061.2, 1241.0, 1505.6, 1741.0],
  netProfit: [412.1, 466.9, 524.6, 627.2, 747.3, 862.0],
  grossMargin: [91.5, 91.4, 91.5, 91.9, 91.8, 92.0],
  netMargin: [46.4, 47.6, 49.4, 50.5, 49.6, 49.5],
  roe: [33.1, 31.2, 30.5, 31.2, 33.4, 34.8],
  operatingCashFlow: [452.4, 516.7, 557.6, 578.6, 665.9, 780.0],
  eps: [32.8, 37.17, 41.76, 49.93, 59.49, 68.64],
  totalAssets: [1830.0, 2133.0, 2545.0, 2960.0, 3520.0, 4100.0],
  totalLiabilities: [460.0, 543.0, 620.0, 720.0, 850.0, 950.0],
  equity: [1370.0, 1590.0, 1925.0, 2240.0, 2670.0, 3150.0],
  accountsReceivable: [0.5, 0.3, 0.2, 0.1, 0.1, 0.1],
  inventory: [253.0, 288.0, 333.0, 388.0, 450.0, 510.0],
  goodwill: [0, 0, 0, 0, 0, 0],
  debtRatio: [25.1, 25.4, 24.4, 24.3, 24.1, 23.2],
};

export const MOUTAI_VALUATION: ValuationData = {
  currentPrice: 1580.0,
  pe: 23.0,
  pb: 8.2,
  ps: 11.5,
  marketCap: 19850,
  historicalPE: [
    { year: '2019', pe: 38.5 },
    { year: '2020', pe: 56.2 },
    { year: '2021', pe: 42.8 },
    { year: '2022', pe: 39.5 },
    { year: '2023', pe: 30.2 },
    { year: '2024', pe: 23.0 },
  ],
  peerComparison: [
    { name: '五粮液', code: '000858', pe: 18.5, pb: 5.2, roe: 25.8, marketCap: 5200 },
    { name: '泸州老窖', code: '000568', pe: 17.8, pb: 6.8, roe: 32.5, marketCap: 2800 },
    { name: '山西汾酒', code: '600809', pe: 22.5, pb: 8.5, roe: 38.2, marketCap: 3100 },
    { name: '洋河股份', code: '002304', pe: 14.2, pb: 3.5, roe: 18.6, marketCap: 1800 },
  ],
};
