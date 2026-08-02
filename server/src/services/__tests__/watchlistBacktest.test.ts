import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWatchlistNewsBacktest } from '../watchlistBacktest.js';
import { fetchOHLCVData } from '../../quant/dataProvider.js';
import { extractNewsSignal } from '../../quant/newsSignal.js';
import { generateStrategyList } from '../strategyListEngine.js';
import { loadStockMaster } from '../stockMaster.js';

vi.mock('../../quant/dataProvider.js');
vi.mock('../../quant/newsSignal.js');
vi.mock('../strategyListEngine.js');
vi.mock('../stockMaster.js');

const baseKline = [
  { date: '2024-01-02', open: 10, close: 11, high: 12, low: 9, volume: 1000 },
  { date: '2024-01-03', open: 11, close: 12, high: 13, low: 10, volume: 1000 },
];

const baseStrategy = [
  {
    strategyType: '均线交叉',
    sharpeRatio: 1.2,
    maxDrawdown: -5,
    winRate: 60,
    totalReturn: 10,
    applicableMarket: 'x',
    fatalWeakness: 'y',
    backtestWarning: 'w',
  },
];

const noNews = {
  signal: {
    hasNews: false,
    polarity: 0,
    sentimentZ: 0,
    bullishRatio: 0,
    newsCount: 0,
    freshness: 0,
    weightedImpact: 0,
    items: [],
  },
  source: 'none' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchOHLCVData).mockResolvedValue(baseKline);
  vi.mocked(extractNewsSignal).mockResolvedValue(noNews);
  vi.mocked(generateStrategyList).mockResolvedValue(baseStrategy);
  vi.mocked(loadStockMaster).mockResolvedValue([]);
});

describe('runWatchlistNewsBacktest', () => {
  it('空代码数组 → 0 行结果', async () => {
    const report = await runWatchlistNewsBacktest([]);
    expect(report.count).toBe(0);
    expect(report.results).toEqual([]);
  });

  it('无新闻：返回策略清单与最优策略，不标新闻', async () => {
    const report = await runWatchlistNewsBacktest(['600519']);
    expect(report.count).toBe(1);
    expect(report.withNewsCount).toBe(0);
    const row = report.results[0];
    expect(row.newsSentiment).toBeNull();
    expect(row.strategyList).toHaveLength(1);
    expect(row.bestStrategy?.strategyType).toBe('均线交叉');
    expect(row.simulatedKline).toBe(false);
    expect(row.name).toBeNull(); // 主数据缺省
  });

  it('含新闻：把 polarity 透传给策略回测，并标记新闻', async () => {
    vi.mocked(extractNewsSignal).mockResolvedValue({
      signal: {
        hasNews: true,
        polarity: 0.4,
        sentimentZ: 0.5,
        bullishRatio: 0.8,
        newsCount: 3,
        freshness: 0.9,
        weightedImpact: 0.36,
        items: [],
      },
      source: 'live',
    });
    vi.mocked(generateStrategyList).mockResolvedValue([
      {
        ...baseStrategy[0],
        newsAware: {
          totalReturn: 12,
          sharpeRatio: 1.3,
          maxDrawdown: -4,
          winRate: 62,
          posture: 0.7,
        },
      },
    ]);

    const report = await runWatchlistNewsBacktest(['600519']);
    expect(report.withNewsCount).toBe(1);
    const row = report.results[0];
    expect(row.newsSentiment?.polarity).toBe(0.4);
    expect(row.bestStrategy?.newsAware?.posture).toBe(0.7);
    // 确认新闻信号确实传给了策略引擎
    expect(vi.mocked(generateStrategyList).mock.calls[0][2]).toEqual({ polarity: 0.4 });
  });

  it('取数失败：单只报错但不影响其余，error 字段填充', async () => {
    vi.mocked(fetchOHLCVData).mockRejectedValueOnce(new Error('网络不可达'));
    const report = await runWatchlistNewsBacktest(['600001', '600519']);
    expect(report.count).toBe(2);
    expect(report.results[0].error).toBeTruthy();
    expect(report.results[0].strategyList).toEqual([]);
    expect(report.results[1].error).toBeUndefined();
  });

  it('模拟 K 线（isSimulated）被标记 simulatedKline', async () => {
    vi.mocked(fetchOHLCVData).mockResolvedValue([
      { ...baseKline[0], isSimulated: true },
    ]);
    const report = await runWatchlistNewsBacktest(['600519']);
    expect(report.results[0].simulatedKline).toBe(true);
  });
});
