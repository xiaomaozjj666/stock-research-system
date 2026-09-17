/**
 * ============================================================================
 * getData 返回值不得是缓存对象本身（缓存污染回归测试）
 * ----------------------------------------------------------------------------
 * 缺陷：getData 把内存 LRU / 磁盘缓存里的对象**直接返回引用**，而调用方
 * （services/analysisPipeline.ts）会就地改写它——修正 PE/PB、写入 historicalPE。
 * 后果是一份**从未由 API 提供过**的「修正后」数据被写进内存缓存甚至落盘 JSON：
 * 之后 /api/quant/valuation/model 等拿到的 PE 取决于「谁先跑过」，同一份数据在
 * 不同请求间口径不一致。
 *
 * 本文件用两个视角钉住该不变量：
 *   1. 内存缓存视角：取一次 → 就地改写返回值 → 再取一次，第二次必须是原始值；
 *   2. 磁盘缓存视角：改写后重载模块（清空内存 LRU）再取，磁盘命中的也必须是原始值，
 *      且磁盘 JSON 里不存在被改写的字段。
 * 两者在修复前都会失败（第二次拿到的是被改写的对象 / 磁盘 JSON 带上了 historicalPE）。
 *
 * 隔离：数据源全部替身，DATA_CACHE_DIR 指向临时目录（不读真实运行时数据）。
 * ============================================================================
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../dataFetcher.js', () => ({
  fetchStockInfo: vi.fn(),
  fetchFinancialData: vi.fn(),
  fetchValuationData: vi.fn(),
}));
vi.mock('../peerService.js', () => ({
  resolveStockIndustry: vi.fn(async () => '白酒'),
  buildPeerComparison: vi.fn(async () => []),
}));

import { fetchStockInfo, fetchFinancialData, fetchValuationData } from '../dataFetcher.js';

const mockFetchInfo = vi.mocked(fetchStockInfo);
const mockFetchFinancial = vi.mocked(fetchFinancialData);
const mockFetchValuation = vi.mocked(fetchValuationData);

let cacheDir = '';
const origCacheDir = process.env.DATA_CACHE_DIR;

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), 'srs-datacache-'));
  process.env.DATA_CACHE_DIR = cacheDir;
  vi.clearAllMocks();
  // 每次返回**全新对象**：否则「第二次取到的是 mock 的同一个对象」会掩盖缓存污染
  mockFetchInfo.mockImplementation(async (code: string) => ({
    code,
    name: '测试股',
    industry: '白酒',
    market: '上交所',
    listingDate: '',
    description: '',
  }));
  mockFetchFinancial.mockImplementation(async () => ({
    years: ['2023', '2024'],
    revenue: [100, 120],
    netProfit: [20, 25],
    grossMargin: [90, 91],
    netMargin: [20, 21],
    roe: [25, 26],
    operatingCashFlow: [22, 27],
    eps: [1.5, 2],
    totalAssets: [500, 550],
    totalLiabilities: [100, 110],
    equity: [400, 440],
    accountsReceivable: [5, 6],
    inventory: [10, 12],
    goodwill: [0, 0],
    debtRatio: [20, 20],
    dataQuality: { estimatedFields: [], missingFields: [] },
  }));
  mockFetchValuation.mockImplementation(async () => ({
    currentPrice: 1800,
    pe: 30, // API 口径
    pb: 6,
    ps: 10,
    marketCap: 22600,
    historicalPE: [{ year: '2024', pe: 30, isEstimated: false }],
    peerComparison: [],
  }));
});

afterEach(() => {
  if (origCacheDir === undefined) delete process.env.DATA_CACHE_DIR;
  else process.env.DATA_CACHE_DIR = origCacheDir;
  rmSync(cacheDir, { recursive: true, force: true });
});

/** 模拟 analysisPipeline 的就地改写：修正 PE/PB + 估算并写入 historicalPE */
function mutateLikeAnalysisPipeline(ds: {
  valuation: { pe: number; pb: number; historicalPE: unknown[] };
}): void {
  ds.valuation.pe = 999;
  ds.valuation.pb = 888;
  ds.valuation.historicalPE = [{ year: '2026', pe: 999, isEstimated: false }];
}

describe('getData 缓存隔离：调用方就地改写不得污染缓存', () => {
  it('内存缓存视角：改写第一次的返回值后，第二次取到的仍是原始值', async () => {
    const { getData } = await import('../dataService.js');

    const first = await getData('600519');
    expect(first.valuation.pe).toBe(30);
    mutateLikeAnalysisPipeline(first);
    // 返回值确实是调用方自己的副本（改写生效）
    expect(first.valuation.pe).toBe(999);

    const second = await getData('600519');
    expect(second.valuation.pe).toBe(30);
    expect(second.valuation.pb).toBe(6);
    expect(second.valuation.historicalPE).toEqual([{ year: '2024', pe: 30, isEstimated: false }]);
    // 两次返回不能是同一个对象引用
    expect(second).not.toBe(first);
    expect(second.valuation).not.toBe(first.valuation);
  });

  it('磁盘缓存视角：改写后重载模块（清空内存 LRU），磁盘命中的仍是原始值', async () => {
    const mod1 = await import('../dataService.js');
    const first = await mod1.getData('000001');
    mutateLikeAnalysisPipeline(first);

    // 重载模块：内存 LRU 归零，下一次取数只能命中磁盘缓存
    vi.resetModules();
    const mod2 = await import('../dataService.js');
    const fromDisk = await mod2.getData('000001');

    expect(fromDisk.valuation.pe).toBe(30);
    expect(fromDisk.valuation.pb).toBe(6);
    expect(fromDisk.valuation.historicalPE).toEqual([{ year: '2024', pe: 30, isEstimated: false }]);
    // 数据源只被调用一次（第二次是缓存命中，不是重新抓取）
    expect(mockFetchValuation).toHaveBeenCalledTimes(1);
  });

  it('磁盘 JSON 内容不含任何被改写的字段（污染不得落盘）', async () => {
    const mod1 = await import('../dataService.js');
    mutateLikeAnalysisPipeline(await mod1.getData('600000'));

    // 重载模块 → 内存 LRU 归零 → 从磁盘读回来再改写一次
    vi.resetModules();
    const mod2 = await import('../dataService.js');
    const fromDisk = await mod2.getData('600000');
    mutateLikeAnalysisPipeline(fromDisk);

    const raw = readFileSync(join(cacheDir, '600000.json'), 'utf-8');
    expect(raw).not.toContain('999');
    const parsed = JSON.parse(raw) as { data: { valuation: { pe: number; pb: number } } };
    expect(parsed.data.valuation.pe).toBe(30);
    expect(parsed.data.valuation.pb).toBe(6);
    // 磁盘命中的返回值同样是独立副本
    expect(fromDisk.valuation.pe).toBe(999);
    const again = await mod2.getData('600000');
    expect(again.valuation.pe).toBe(30);
  });
});
