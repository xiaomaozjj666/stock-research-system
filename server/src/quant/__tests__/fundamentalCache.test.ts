import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FinancialData } from '../../types.js';

vi.mock('../../services/dataFetcher.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/dataFetcher.js')>();
  return { ...actual, fetchFinancialData: vi.fn() };
});
vi.mock('../../services/quarterlyFinancials.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/quarterlyFinancials.js')>();
  return { ...actual, fetchQuarterlyFinancials: vi.fn() };
});

import { fetchFinancialDataCached, fetchQuarterlyFinancialsCached } from '../fundamentalCache.js';
import { fetchFinancialData } from '../../services/dataFetcher.js';
import { fetchQuarterlyFinancials } from '../../services/quarterlyFinancials.js';
import type { QuarterlySeries } from '../../services/quarterlyFinancials.js';

const mockedFinancial = vi.mocked(fetchFinancialData);
const mockedQuarterly = vi.mocked(fetchQuarterlyFinancials);

/**
 * 基本面缓存单测：TTL 内命中零网络、显式 0 关闭缓存、失败不写缓存、
 * 季度序列按 (code, limit) 分键。
 * 缓存目录经 DATA_CACHE_DIR 重定向到进程专属临时目录。
 */
let CACHE_DIR = '';
const origCacheDir = process.env.DATA_CACHE_DIR;
const origFinTtl = process.env.QUANT_FINANCIAL_CACHE_TTL_HOURS;
const origQttl = process.env.QUANT_QUARTERLY_CACHE_TTL_HOURS;

const FIN = { code: '600519', pe: 10 } as unknown as FinancialData;
const QS = { points: [] } as unknown as QuarterlySeries;

beforeEach(() => {
  // vi.restoreAllMocks 不清 mock 工厂 vi.fn() 的调用历史，按仓库惯例显式 reset
  mockedFinancial.mockReset();
  mockedQuarterly.mockReset();
  CACHE_DIR = mkdtempSync(join(tmpdir(), 'srs-fund-cache-'));
  process.env.DATA_CACHE_DIR = CACHE_DIR;
});
afterEach(() => {
  vi.restoreAllMocks();
  if (origCacheDir === undefined) delete process.env.DATA_CACHE_DIR;
  else process.env.DATA_CACHE_DIR = origCacheDir;
  if (origFinTtl === undefined) delete process.env.QUANT_FINANCIAL_CACHE_TTL_HOURS;
  else process.env.QUANT_FINANCIAL_CACHE_TTL_HOURS = origFinTtl;
  if (origQttl === undefined) delete process.env.QUANT_QUARTERLY_CACHE_TTL_HOURS;
  else process.env.QUANT_QUARTERLY_CACHE_TTL_HOURS = origQttl;
  rmSync(CACHE_DIR, { recursive: true, force: true });
});

describe('fetchFinancialDataCached', () => {
  it('TTL 内命中 → 底层只调用一次', async () => {
    process.env.QUANT_FINANCIAL_CACHE_TTL_HOURS = '24';
    mockedFinancial.mockResolvedValue(FIN);
    const first = await fetchFinancialDataCached('600519');
    const second = await fetchFinancialDataCached('600519');
    expect(second).toEqual(first);
    expect(mockedFinancial).toHaveBeenCalledTimes(1);
  });

  it('QUANT_FINANCIAL_CACHE_TTL_HOURS=0 → 关闭缓存，每次都调用底层', async () => {
    process.env.QUANT_FINANCIAL_CACHE_TTL_HOURS = '0';
    mockedFinancial.mockResolvedValue(FIN);
    await fetchFinancialDataCached('600519');
    await fetchFinancialDataCached('600519');
    expect(mockedFinancial).toHaveBeenCalledTimes(2);
  });

  it('底层抛错 → 不写缓存，错误上抛；恢复后重试成功', async () => {
    process.env.QUANT_FINANCIAL_CACHE_TTL_HOURS = '24';
    mockedFinancial.mockRejectedValue(new Error('无法获取财务数据'));
    await expect(fetchFinancialDataCached('600519')).rejects.toThrow(/无法获取/);
    // 失败不留缓存：下一次调用仍会真正尝试底层
    mockedFinancial.mockResolvedValue(FIN);
    const r = await fetchFinancialDataCached('600519');
    expect(r).toEqual(FIN);
    expect(mockedFinancial).toHaveBeenCalledTimes(2);
  });
});

describe('fetchQuarterlyFinancialsCached', () => {
  it('季度序列按 (code, limit) 分键缓存', async () => {
    process.env.QUANT_QUARTERLY_CACHE_TTL_HOURS = '168';
    mockedQuarterly.mockResolvedValue(QS);
    await fetchQuarterlyFinancialsCached('600519', 16);
    await fetchQuarterlyFinancialsCached('600519', 16); // 命中
    await fetchQuarterlyFinancialsCached('600519', 8); // 不同 limit → 未命中
    expect(mockedQuarterly).toHaveBeenCalledTimes(2);
    expect(mockedQuarterly).toHaveBeenNthCalledWith(1, '600519', 16);
    expect(mockedQuarterly).toHaveBeenNthCalledWith(2, '600519', 8);
  });

  it('QUANT_QUARTERLY_CACHE_TTL_HOURS=0 → 关闭缓存', async () => {
    process.env.QUANT_QUARTERLY_CACHE_TTL_HOURS = '0';
    mockedQuarterly.mockResolvedValue(QS);
    await fetchQuarterlyFinancialsCached('600519', 16);
    await fetchQuarterlyFinancialsCached('600519', 16);
    expect(mockedQuarterly).toHaveBeenCalledTimes(2);
  });
});
