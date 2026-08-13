import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SecurityMasterEntry } from '../stockMaster.js';

// 磁盘缓存经 MASTER_CACHE env 重定向到进程专属临时文件（此前直接读写删除真实
// server/src/data/stockMaster.json，会破坏开发者机器上真实下载的证券全表缓存）。
// 网络边界用 mock 全局 fetch（fetchJson 内部走 fetch）。
const tmpDir = mkdtempSync(join(tmpdir(), 'stock-master-'));
const CACHE_FILE = join(tmpDir, 'stockMaster.json');
const originalFetch = globalThis.fetch;

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));

// 动态 import + resetModules：loadStockMaster 的 masterCache/masterLoadPromise 是模块级
// 状态，逐用例重新加载模块可消除"内存缓存跨用例存续"的顺序依赖
let loadStockMaster: (force?: boolean) => Promise<SecurityMasterEntry[]>;
let fuzzyMatch: (query: string, master: SecurityMasterEntry[]) => SecurityMasterEntry[];

/** 构造一页 diff（模拟东方财富 clist 返回结构） */
function pageItems(
  n: number,
  offset = 0,
): Record<string, { f12: string; f14: string; f100: string }> {
  const diff: Record<string, { f12: string; f14: string; f100: string }> = {};
  for (let i = 1; i <= n; i++) {
    diff[`item${i}`] = { f12: String(600000 + offset + i), f14: `股票${offset + i}`, f100: '行业' };
  }
  return diff;
}

/** 让 fetch mock 依次返回指定 clist 页数据 */
function mockFetchPage(pages: Array<{ total: number; diff: Record<string, unknown> }>): void {
  mocks.fetch.mockImplementation(async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => JSON.stringify({ data: pages.shift() }),
  }));
}

function writeCache(payload: unknown): void {
  writeFileSync(CACHE_FILE, JSON.stringify(payload), 'utf-8');
}

describe('loadStockMaster', () => {
  beforeEach(async () => {
    vi.resetModules(); // 重置模块级内存缓存（masterCache）
    const mod = await import('../stockMaster.js');
    loadStockMaster = mod.loadStockMaster;
    fuzzyMatch = mod.fuzzyMatch;
    process.env.MASTER_CACHE = CACHE_FILE;
    globalThis.fetch = mocks.fetch;
    mocks.fetch.mockReset();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.MASTER_CACHE;
    try {
      rmSync(CACHE_FILE, { force: true });
    } catch {
      /* 清理失败忽略 */
    }
  });

  it('磁盘缓存新鲜且格式有效时直接使用，不调用 API', async () => {
    // 磁盘缓存有效性要求 data.length > 1000（防旧格式），构造 1001 条
    const bigData: SecurityMasterEntry[] = [];
    for (let i = 0; i < 1001; i++) {
      bigData.push({ code: String(600000 + i), name: `股票${i}`, industry: '行业' });
    }
    bigData[0] = { code: '600519', name: '贵州茅台', industry: '白酒' };
    writeCache({ timestamp: Date.now(), data: bigData });
    const result = await loadStockMaster();
    expect(result[0].code).toBe('600519');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('磁盘缓存过期/空数据/旧格式时回退到 API', async () => {
    writeCache({ timestamp: Date.now() - 48 * 60 * 60 * 1000, data: [] });
    mockFetchPage([{ total: 1, diff: pageItems(1) }]);
    const result = await loadStockMaster(true);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(result.length).toBe(1);
  });

  it('磁盘缓存文件损坏时忽略并走 API', async () => {
    writeCache('{ not valid json');
    mockFetchPage([{ total: 1, diff: pageItems(1) }]);
    const result = await loadStockMaster(true);
    expect(result.length).toBe(1);
  });

  it('无缓存时从 API 分页拉取全量（多页直到 total）', async () => {
    mockFetchPage([
      { total: 1000, diff: pageItems(500) },
      { total: 1000, diff: pageItems(500, 500) },
    ]);
    const result = await loadStockMaster(true);
    expect(result.length).toBe(1000);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    const secondUrl = mocks.fetch.mock.calls[1][0] as string;
    expect(secondUrl).toContain('pn=2');
  });

  it('API 返回空页时提前 break，不继续翻页', async () => {
    mockFetchPage([
      { total: 1000, diff: pageItems(500) },
      { total: 1000, diff: {} },
    ]);
    const result = await loadStockMaster(true);
    expect(result.length).toBe(500);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it('内存缓存命中后再次调用不重新拉取', async () => {
    mockFetchPage([{ total: 1, diff: pageItems(1) }]);
    const first = await loadStockMaster(true);
    mocks.fetch.mockClear();
    const second = await loadStockMaster();
    expect(second).toEqual(first);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('force=true 强制刷新，绕过内存缓存', async () => {
    mockFetchPage([{ total: 1, diff: pageItems(1) }]);
    await loadStockMaster(true);
    mocks.fetch.mockClear();
    mockFetchPage([{ total: 2, diff: pageItems(2) }]);
    const result = await loadStockMaster(true);
    expect(result.length).toBe(2);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('fuzzyMatch 公共子串（长度>=2）走 60 分档（非包含关系）', async () => {
    const master: SecurityMasterEntry[] = [{ code: '600519', name: '贵州茅台', industry: '白酒' }];
    // 「茅台酒」与「贵州茅台」互不包含，但公共子串「茅台」长度 2 → 60 分档
    const r = fuzzyMatch('茅台酒', master);
    expect(r.some((e) => e.code === '600519')).toBe(true);
  });
});
