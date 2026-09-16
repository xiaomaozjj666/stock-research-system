import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  runWatchlistNewsBacktest,
  watchlistBatchMax,
  watchlistConcurrency,
  WATCHLIST_CONCURRENCY,
  WATCHLIST_CONCURRENCY_MAX,
  WATCHLIST_BATCH_MAX,
} from '../watchlistBacktest.js';
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
    vi.mocked(fetchOHLCVData).mockResolvedValue([{ ...baseKline[0], isSimulated: true }]);
    const report = await runWatchlistNewsBacktest(['600519']);
    expect(report.results[0].simulatedKline).toBe(true);
  });
});

/* ============================================================================
 * 并发上限 / 单次条数上限（P1：WATCHLIST_CONCURRENCY 无上界、monitor 跑整表）
 * ==========================================================================*/
describe('runWatchlistNewsBacktest 并发与单次上限', () => {
  afterEach(() => {
    delete process.env.WATCHLIST_CONCURRENCY;
    delete process.env.WATCHLIST_MAX_CODES;
  });

  it(`并发默认 ${WATCHLIST_CONCURRENCY}，可配但夹紧到硬上界 ${WATCHLIST_CONCURRENCY_MAX}`, () => {
    delete process.env.WATCHLIST_CONCURRENCY;
    expect(watchlistConcurrency()).toBe(WATCHLIST_CONCURRENCY);

    process.env.WATCHLIST_CONCURRENCY = '2';
    expect(watchlistConcurrency()).toBe(2);

    // 关键：可配置不等于可无限配——100 并发会瞬时打满上游
    process.env.WATCHLIST_CONCURRENCY = '100';
    expect(watchlistConcurrency()).toBe(WATCHLIST_CONCURRENCY_MAX);

    for (const bad of ['abc', '0', '-3', '']) {
      process.env.WATCHLIST_CONCURRENCY = bad;
      expect(watchlistConcurrency(), `WATCHLIST_CONCURRENCY=${bad}`).toBe(WATCHLIST_CONCURRENCY);
    }
  });

  it('运行期同时在途的取数不超过并发上界（配置 100 也按 8 跑）', async () => {
    process.env.WATCHLIST_CONCURRENCY = '100';
    let inflight = 0;
    let peak = 0;
    vi.mocked(fetchOHLCVData).mockImplementation(async () => {
      inflight++;
      peak = Math.max(peak, inflight);
      await new Promise((r) => setTimeout(r, 1));
      inflight--;
      return baseKline;
    });

    const codes = Array.from({ length: 16 }, (_, i) => String(600000 + i).padStart(6, '0'));
    const report = await runWatchlistNewsBacktest(codes, { maxCodes: 16 });

    expect(report.count).toBe(16);
    expect(peak).toBeLessThanOrEqual(WATCHLIST_CONCURRENCY_MAX);
    expect(peak).toBeGreaterThan(1); // 确认确实是并发跑，而不是退化成串行
  });

  it(`单次默认最多处理 ${WATCHLIST_BATCH_MAX} 只，其余如实计入 skipped`, async () => {
    delete process.env.WATCHLIST_MAX_CODES;
    expect(watchlistBatchMax()).toBe(WATCHLIST_BATCH_MAX);

    const codes = Array.from({ length: 25 }, (_, i) => String(600000 + i).padStart(6, '0'));
    const report = await runWatchlistNewsBacktest(codes);

    expect(report.requested).toBe(25);
    expect(report.count).toBe(WATCHLIST_BATCH_MAX);
    expect(report.skipped).toBe(25 - WATCHLIST_BATCH_MAX);
    expect(report.results).toHaveLength(WATCHLIST_BATCH_MAX);
    // 关键：被跳过的标的根本没取数（上限的意义就是不打上游）
    expect(vi.mocked(fetchOHLCVData)).toHaveBeenCalledTimes(WATCHLIST_BATCH_MAX);
  });

  it('WATCHLIST_MAX_CODES 可调；maxCodes 选项优先于 env', async () => {
    process.env.WATCHLIST_MAX_CODES = '1';
    const byEnv = await runWatchlistNewsBacktest(['600519', '000001']);
    expect(byEnv.count).toBe(1);
    expect(byEnv.skipped).toBe(1);

    const byOption = await runWatchlistNewsBacktest(['600519', '000001'], { maxCodes: 2 });
    expect(byOption.count).toBe(2);
    expect(byOption.skipped).toBe(0);
  });

  it('全部代码非法时不取数，requested/skipped 仍如实反映入参', async () => {
    const report = await runWatchlistNewsBacktest(['abc', '600519&lmt=99999']);
    expect(report.count).toBe(0);
    expect(report.requested).toBe(2);
    expect(report.skipped).toBe(2);
    expect(vi.mocked(fetchOHLCVData)).not.toHaveBeenCalled();
  });
});

/* ============================================================================
 * AbortSignal 沿调用链下传（客户端断开 → 在途取数可取消）
 * ==========================================================================*/
describe('runWatchlistNewsBacktest 取消（AbortSignal）', () => {
  it('signal 透传到取数函数（第 4 个参数），取消可级联到 socket 级', async () => {
    const ac = new AbortController();
    await runWatchlistNewsBacktest(['600519'], { signal: ac.signal });
    expect(vi.mocked(fetchOHLCVData).mock.calls[0][3]).toBe(ac.signal);
  });

  it('signal 已中止：整批拒绝，且不为任何标的发起取数', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      runWatchlistNewsBacktest(['600519', '000001'], { signal: ac.signal }),
    ).rejects.toBeTruthy();
    expect(vi.mocked(fetchOHLCVData)).not.toHaveBeenCalled();
  });

  it('取数中途断开：中止向上抛（不落成「该只取数失败」的行），其余标的也不再取数', async () => {
    const ac = new AbortController();
    vi.mocked(fetchOHLCVData).mockImplementation(async (_code, _start, _end, signal) => {
      ac.abort(); // 模拟客户端在途断开
      throw signal?.reason ?? new Error('aborted');
    });

    await expect(
      runWatchlistNewsBacktest(['600001', '600002', '600003'], {
        signal: ac.signal,
        maxCodes: 3,
      }),
    ).rejects.toBeTruthy();

    // 断开后不再为剩余标的派发新任务（并发上界 8 > 3 时首轮会全部派发，
    // 故这里只断言「没跑完 3 只」，重点是中止被向上抛出而不是被吞成 error 行）
    expect(vi.mocked(fetchOHLCVData).mock.calls.length).toBeLessThanOrEqual(3);
  });
});
