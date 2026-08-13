import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runAnalysis } from '../analysisPipeline.js';
import type { StockDataSet, FinancialData, ValuationData, StockInfo } from '../../types.js';
import { buildFinancialGraph } from '../../llm/knowledgeGraph.js';
import { calculateSectorRotation } from '../../quant/sectorRotation.js';

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

const sampleData: StockDataSet = {
  info: sampleInfo,
  financial: sampleFinancial,
  valuation: sampleValuation,
};

vi.mock('../dataService.js', () => ({
  getData: vi.fn(async () => sampleData),
}));

vi.mock('../../quant/dataProvider.js', () => ({
  fetchOHLCVData: vi.fn(async () => []), // 无K线 -> 策略清单为空，不触发网络
}));

// 可选增强模块默认返回 undefined → 流水线内部降级跳过；成功/失败路径在用例中切换
vi.mock('../../llm/knowledgeGraph.js', () => ({
  buildFinancialGraph: vi.fn(),
}));
vi.mock('../../quant/sectorRotation.js', () => ({
  calculateSectorRotation: vi.fn(),
}));

// 静态取 mock 的 getData（vi.mock hoisted），供 beforeEach 重置默认返回值
import { getData } from '../dataService.js';

describe('runAnalysis 流水线', () => {
  beforeEach(() => {
    // 重置 mock 默认值：此前"不同财务特征"用例把 getData 永久替换为 weakData、
    // 增强 mock 跨 describe 改写且无还原，依赖文件内声明顺序（乱序/重跑即破）
    vi.mocked(getData).mockResolvedValue(sampleData);
    vi.mocked(buildFinancialGraph).mockReturnValue(undefined as never);
    vi.mocked(calculateSectorRotation).mockReturnValue(undefined as never);
  });

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

describe('可选增强：知识图谱 / 行业轮动成功路径', () => {
  it('增强字段存在且结构合法（不改变现有输出契约）', async () => {
    // 提供有效返回：知识图谱上下文 + 行业轮动信号
    vi.mocked(buildFinancialGraph).mockReturnValue({
      toContextString: () => '【知识图谱】stock:600519 贵州茅台 ->[belongs_to]-> 白酒',
    } as ReturnType<typeof buildFinancialGraph>);
    vi.mocked(calculateSectorRotation).mockReturnValue({
      date: '2026-08-08',
      signals: [
        {
          sector: '白酒',
          prosperity: 60,
          trend: 55,
          crowding: 40,
          compositeScore: 62,
          rank: 1,
          recommendation: 'overweight' as const,
        },
      ],
      topSectors: ['白酒'],
      bottomSectors: [],
      summary: '本期共评估 1 个行业。超配：白酒；低配：无。',
    });

    const result = await runAnalysis('600519');
    const stock = result.stock_pool[0];

    // 知识图谱上下文（有同业可比数据时附加）
    expect(stock.knowledgeGraphContext).toContain('【知识图谱】');

    // 行业轮动信号（有行业归属时附加）
    expect(stock.sectorRotation).toBeDefined();
    expect(stock.sectorRotation!.sector).toBe('白酒');
    expect(stock.sectorRotation!.rank).toBe(1);
    expect(['overweight', 'neutral', 'underweight']).toContain(
      stock.sectorRotation!.recommendation,
    );
    expect(typeof stock.sectorRotation!.compositeScore).toBe('number');
    expect(typeof stock.sectorRotation!.industryBeta).toBe('number');
    expect(stock.sectorRotation!.date).toBe('2026-08-08');

    // 核心输出契约不受增强影响
    expect(stock.stock_code).toBe('600519');
    expect(stock.total_score).toBeGreaterThanOrEqual(0);
  });
});

describe('可选增强：失败降级不崩', () => {
  it('知识图谱/行业轮动增强抛错时，报告仍正常生成且增强字段缺失', async () => {
    vi.mocked(buildFinancialGraph).mockImplementation(() => {
      throw new Error('图谱构建失败');
    });
    vi.mocked(calculateSectorRotation).mockImplementation(() => {
      throw new Error('轮动计算失败');
    });

    const result = await runAnalysis('600519');
    const stock = result.stock_pool[0];

    // 输出契约不变：核心字段仍完整
    expect(stock.stock_code).toBe('600519');
    expect(stock.rating).toBeTruthy();
    expect(stock.core_summary).toContain('贵州茅台');
    expect(stock.expert_opinions.length).toBeGreaterThanOrEqual(6);

    // 增强字段降级为 undefined（try/catch 吞错，不阻断主流程）
    expect(stock.knowledgeGraphContext).toBeUndefined();
    expect(stock.sectorRotation).toBeUndefined();
  });
});
