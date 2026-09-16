import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWatchlistNewsBacktest } from '../watchlistBacktest.js';

/**
 * 客户端断开 → 在途取数取消（走**真实** quant/dataProvider，只打桩最外层 fetch）
 * ----------------------------------------------------------------------------
 * 与 services/__tests__/watchlistBacktest.test.ts 的区别：那份测试把 fetchOHLCVData 整个
 * 打桩，只能证明「signal 传进了取数函数」；本文件把 dataProvider 换成真实实现，
 * 只桩掉最外层的 globalThis.fetch，用来证明取消**一路级联到 socket 层**：
 *   runWatchlistNewsBacktest → fetchOHLCVData → fetchKlineBySecid → fetchKlineRange
 *   → fetch(url, { signal })
 *
 * 隔离：新闻信号/策略引擎打桩（与取消无关）；缓存目录指向临时目录，不碰真实缓存。
 */

vi.mock('../../quant/newsSignal.js', () => ({
  extractNewsSignal: vi.fn(async () => ({
    signal: { hasNews: false, polarity: 0, items: [] },
    source: 'none',
  })),
  earliestNewsDate: vi.fn(() => null),
  fetchLatestNews: vi.fn(async () => []),
  lexiconPolarity: vi.fn(() => 0),
  aggregateNewsSentiment: vi.fn(() => ({ hasNews: false, polarity: 0, items: [] })),
  NEWS_MODEL_CONSTANTS: { RECENCY_LAMBDA: 0.12, Z_CLIP: 0.001, HALF_LIFE_DAYS: 5.8 },
}));

vi.mock('../strategyListEngine.js', () => ({
  generateStrategyList: vi.fn(async () => []),
}));

vi.mock('../stockMaster.js', () => ({
  loadStockMaster: vi.fn(async () => []),
}));

const fetchMock = vi.fn();
let cacheDir = '';
const origCacheDir = process.env.DATA_CACHE_DIR;

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), 'watchlist-abort-'));
  process.env.DATA_CACHE_DIR = cacheDir;
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (origCacheDir === undefined) delete process.env.DATA_CACHE_DIR;
  else process.env.DATA_CACHE_DIR = origCacheDir;
  rmSync(cacheDir, { recursive: true, force: true });
});

describe('断开取消：AbortSignal 级联到 fetch 层', () => {
  it('客户端在途断开：传给 fetch 的 signal 被置位，整批以中止结束（不再为剩余标的取数）', async () => {
    const ac = new AbortController();
    let fetchSignal: AbortSignal | undefined;

    fetchMock.mockImplementation((_url: string, init?: { signal?: AbortSignal }) => {
      fetchSignal = init?.signal;
      // 模拟"请求已发出但上游很慢"：只有 signal 中止才会 reject
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(init.signal?.reason ?? new Error('aborted')),
        );
      });
    });

    const pending = runWatchlistNewsBacktest(['600519', '000001'], {
      signal: ac.signal,
      maxCodes: 2,
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    ac.abort(); // 等价于客户端关页：routes/watchlist.ts 的 res.close 会做这件事

    await expect(pending).rejects.toBeTruthy();
    // 关键证据：dataProvider 内部给 fetch 的 signal 已被置位 → 取消确实到了 socket 层
    expect(fetchSignal?.aborted).toBe(true);
  });

  it('signal 已置位时零外呼（断开后不再发起新的取数）', async () => {
    const ac = new AbortController();
    ac.abort();

    await expect(runWatchlistNewsBacktest(['600519'], { signal: ac.signal })).rejects.toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('不传 signal 时行为不变（既有调用方 autonomous / 批量回测不受影响）', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            klines: [
              '2026-01-02,10.00,10.50,10.60,9.90,1000',
              '2026-01-05,10.50,10.80,10.90,10.40,1200',
            ],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const report = await runWatchlistNewsBacktest(['600519']);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(report.count).toBe(1);
    expect(report.results[0].error).toBeUndefined();
  });
});
