import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanDisplayName, SEARCH_ALIASES, searchStocks } from '../dataService.js';

// 模拟证券全表兜底路径：dataService.searchStocks 在东方财富 suggest 失败时会
// 回退到 loadStockMaster() → fetchJson() → 真实 curl 子进程，在测试环境会挂起超时。
// 这里用空主数据把兜底路径短路，避免触达真实网络。
vi.mock('../stockMaster.js', () => ({
  loadStockMaster: vi.fn(async () => []),
  fuzzyMatch: vi.fn(() => []),
  normalizeName: vi.fn((n: string) => n),
}));

describe('cleanDisplayName', () => {
  it('去除上市窗口期前缀 C（代码覆盖优先）', () => {
    expect(cleanDisplayName('C长鑫', '688825')).toBe('长鑫科技');
    expect(cleanDisplayName('C某某', '600000')).toBe('某某');
  });
  it('去除上市首日前缀 N', () => {
    expect(cleanDisplayName('N新股', '001234')).toBe('新股');
  });
  it('普通名称不受影响', () => {
    expect(cleanDisplayName('贵州茅台', '600519')).toBe('贵州茅台');
  });
  it('代码覆盖表补全被截断的窗口名', () => {
    expect(cleanDisplayName('C长鑫', '688825')).toBe('长鑫科技');
  });
});

describe('SEARCH_ALIASES', () => {
  it('品牌名映射到上市主体简称', () => {
    expect(SEARCH_ALIASES['长鑫存储']).toBe('长鑫科技');
    expect(SEARCH_ALIASES['长鑫']).toBe('长鑫科技');
  });
});

describe('searchStocks', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('品牌名「长鑫存储」经别名改写后命中 688825，且名称规范化', async () => {
    const fetchSpy = vi.fn(async (url: string | URL) => {
      const u = decodeURIComponent(String(url));
      return new Response(
        JSON.stringify({
          QuotationCodeTable: {
            Data: [{ MktNum: '1', Code: '688825', Name: 'C长鑫' }],
          },
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchSpy);
    const r = await searchStocks('长鑫存储');
    expect(r).toEqual([{ code: '688825', name: '长鑫科技' }]);
    // 别名改写断言移到测试体（此前在 mock 内部，失败时定位不清）
    const calledUrl = decodeURIComponent(String(fetchSpy.mock.calls[0][0]));
    expect(calledUrl).toContain('长鑫科技');
  });

  it('直接输入上市简称正常返回', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              QuotationCodeTable: { Data: [{ MktNum: '1', Code: '600519', Name: '贵州茅台' }] },
            }),
            { status: 200 },
          ),
      ),
    );
    const r = await searchStocks('贵州茅台');
    expect(r[0].code).toBe('600519');
    expect(r[0].name).toBe('贵州茅台');
  });

  it('上游无结果时返回空数组（不抛错）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })),
    );
    const r = await searchStocks('量子计算xyz');
    expect(r).toEqual([]);
  });

  it('东方财富 suggest 失败（网络异常）时降级为空而非抛错', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network');
      }),
    );
    const r = await searchStocks('任何词');
    expect(r).toEqual([]);
  });
});
