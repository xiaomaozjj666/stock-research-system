import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fetchJson } from '../../utils/http.js';
import {
  fetchIndustryBoards,
  fetchIndustryBoardsWithMeta,
  fetchBoardConstituents,
  fetchBoardConstituentsWithMeta,
  hasCachedConstituents,
  isValidBoardCode,
  clearUniverseCache,
} from '../universeProvider.js';
import { sanitizeCacheKey } from '../quantCache.js';

vi.mock('../../utils/http.js', () => ({ fetchJson: vi.fn() }));
const mockedFetchJson = vi.mocked(fetchJson);

// 磁盘持久化测试隔离到临时目录，避免污染项目真实 quant/cache
const TEST_CACHE_DIR = path.join(os.tmpdir(), `universe-cache-test-${process.pid}`);
process.env.DATA_CACHE_DIR = TEST_CACHE_DIR;
const seededFiles: string[] = [];

/** 手写一个「已过期」的磁盘快照（模拟上游已挂、但磁盘上还有历史数据） */
function seedStaleDisk(key: string, data: unknown): void {
  fs.mkdirSync(TEST_CACHE_DIR, { recursive: true });
  const file = path.join(TEST_CACHE_DIR, `${sanitizeCacheKey(key)}.json`);
  // timestamp 故意早于 TTL，使 isCacheFresh 判为陈旧
  fs.writeFileSync(
    file,
    JSON.stringify({ data, timestamp: Date.now() - 7 * 24 * 3600 * 1000, ttlMs: 6 * 3600 * 1000 }),
  );
  seededFiles.push(file);
}

afterEach(() => {
  for (const f of seededFiles) fs.rmSync(f, { force: true });
  seededFiles.length = 0;
});

const BOARDS_RESPONSE = {
  data: {
    diff: [
      { f12: 'BK0475', f14: '白酒', f20: 0 },
      { f12: 'BK0428', f14: '电力行业', f20: 0 },
      { f12: 'not-board', f14: '脏数据', f20: 0 }, // 非法代码 → 剔除
      { f12: 'BK0476', f14: '', f20: 0 }, // 空名 → 剔除
    ],
  },
};

/** 6 只成分股（含应剔除的脏行），市值单位元 */
const CONSTITUENTS_RESPONSE = {
  data: {
    diff: [
      { f12: '600519', f14: '贵州茅台', f20: 1.8e12 },
      { f12: '000858', f14: '五粮液', f20: 5.0e11 },
      { f12: 'ABC123', f14: '非A股', f20: 1e10 }, // 非 6 位数字 → 剔除
      { f12: '603288', f14: '海天味业', f20: 'bad' }, // 市值脏值 → marketCap 透出为 undefined
      { f12: '600809', f14: '山西汾酒', f20: 2.2e11 },
    ],
  },
};

/** 旧形态响应：diff 为「下标键对象」而非数组 */
const LEGACY_DIFF_RESPONSE = {
  data: { diff: { 0: { f12: '600519', f14: '贵州茅台', f20: 1.8e12 } } },
};

beforeEach(() => {
  clearUniverseCache();
  vi.mocked(fetchJson).mockReset();
});

describe('isValidBoardCode', () => {
  it('BK + 4~6 位数字合法（大小写不敏感），其余拒绝', () => {
    expect(isValidBoardCode('BK0475')).toBe(true);
    expect(isValidBoardCode('bk0475')).toBe(true);
    expect(isValidBoardCode('BK123456')).toBe(true);
    expect(isValidBoardCode('BK123')).toBe(false);
    expect(isValidBoardCode('0475')).toBe(false);
    expect(isValidBoardCode('BK; DROP')).toBe(false);
  });
});

describe('fetchIndustryBoards', () => {
  it('解析板块列表并剔除脏行', async () => {
    mockedFetchJson.mockResolvedValue(BOARDS_RESPONSE);
    const boards = await fetchIndustryBoards();
    expect(boards).toEqual([
      { code: 'BK0475', name: '白酒' },
      { code: 'BK0428', name: '电力行业' },
    ]);
  });

  it('结果缓存：TTL 内二次调用不再请求远端', async () => {
    mockedFetchJson.mockResolvedValue(BOARDS_RESPONSE);
    await fetchIndustryBoards();
    await fetchIndustryBoards();
    expect(mockedFetchJson).toHaveBeenCalledTimes(1);
  });

  it('远端返回空 → 抛错（不编造列表）', async () => {
    mockedFetchJson.mockResolvedValue({ data: { diff: [] } });
    await expect(fetchIndustryBoards()).rejects.toThrow('行业板块列表');
  });
});

describe('fetchBoardConstituents', () => {
  it('按市值取前 N 只、剔除非 A 股行、元转亿元', async () => {
    mockedFetchJson.mockResolvedValue(CONSTITUENTS_RESPONSE);
    const stocks = await fetchBoardConstituents('BK0475', 10);
    expect(stocks.map((s) => s.code)).toEqual(['600519', '000858', '603288', '600809']);
    expect(stocks[0].marketCap).toBeCloseTo(18000, 6); // 1.8e12 元 = 18000 亿
    expect(stocks[2].marketCap).toBeUndefined(); // 脏市值不透出
    // fs 参数使用板块代码
    const url = mockedFetchJson.mock.calls[0][0] as string;
    expect(url).toContain('fs=b%3ABK0475');
  });

  it('limit 截断成分股数量', async () => {
    mockedFetchJson.mockResolvedValue(CONSTITUENTS_RESPONSE);
    const stocks = await fetchBoardConstituents('BK0475', 2);
    expect(stocks).toHaveLength(2);
  });

  it('板块代码非法 → 抛错且不发起请求', async () => {
    await expect(fetchBoardConstituents('../etc', 5)).rejects.toThrow('无效的板块代码');
    expect(mockedFetchJson).not.toHaveBeenCalled();
  });

  it('兼容 diff 为下标键对象的旧响应形态', async () => {
    mockedFetchJson.mockResolvedValue(LEGACY_DIFF_RESPONSE);
    const stocks = await fetchBoardConstituents('BK0475', 5);
    expect(stocks).toEqual([{ code: '600519', name: '贵州茅台', marketCap: 18000 }]);
  });

  it('成分股全被剔除 → 抛错', async () => {
    mockedFetchJson.mockResolvedValue({ data: { diff: [{ f12: 'X1', f14: 'x', f20: 1 }] } });
    await expect(fetchBoardConstituents('BK0475', 5)).rejects.toThrow('无有效 A 股成分股');
  });
});

describe('fetchBoardConstituentsWithMeta — 四层回退（2026-09-06 加固）', () => {
  it('成功拉取 → stale:false 且落盘到 DATA_CACHE_DIR', async () => {
    mockedFetchJson.mockResolvedValue(CONSTITUENTS_RESPONSE);
    const meta = await fetchBoardConstituentsWithMeta('BK0475', 10);
    expect(meta.stale).toBe(false);
    expect(meta.value.map((s) => s.code)).toEqual(['600519', '000858', '603288', '600809']);
    const file = path.join(TEST_CACHE_DIR, 'universe_cons_BK0475_10.json');
    expect(fs.existsSync(file)).toBe(true);
  });

  it('远端失败但磁盘有陈旧快照 → 回落 stale:true（不 502）', async () => {
    seedStaleDisk('universe_cons_BK0475_10', [
      { code: '600519', name: '贵州茅台' },
      { code: '000858', name: '五粮液' },
    ]);
    clearUniverseCache(); // 清内存缓存，但保留手写的磁盘陈旧快照
    mockedFetchJson.mockRejectedValue(new Error('上游超时'));
    const meta = await fetchBoardConstituentsWithMeta('BK0475', 10);
    expect(meta.stale).toBe(true);
    expect(meta.staleAgeMs).toBeGreaterThan(0);
    expect(meta.value).toHaveLength(2);
  });

  it('远端失败且无任何磁盘快照 → 抛错（绝不编造成分股）', async () => {
    clearUniverseCache();
    mockedFetchJson.mockRejectedValue(new Error('上游超时'));
    await expect(fetchBoardConstituentsWithMeta('BK0475', 10)).rejects.toThrow('上游超时');
  });

  it('hasCachedConstituents：磁盘有快照（含陈旧）→ true；键随 board/topN 归一变化', () => {
    seedStaleDisk('universe_cons_BK0475_10', [{ code: '600519', name: '贵州茅台' }]);
    expect(hasCachedConstituents('BK0475', 10)).toBe(true);
    expect(hasCachedConstituents('bk0475', 10)).toBe(true); // 大小写归一
    expect(hasCachedConstituents('BK0475', 77)).toBe(false); // topN 不同 → 缓存键不同
    expect(hasCachedConstituents('BK9999', 10)).toBe(false); // 从未评估过的板块
    expect(hasCachedConstituents('BAD!', 10)).toBe(false); // 非法代码
  });
});

describe('fetchIndustryBoardsWithMeta — 四层回退（2026-09-06 加固）', () => {
  it('成功拉取 → stale:false 且落盘到 DATA_CACHE_DIR', async () => {
    mockedFetchJson.mockResolvedValue(BOARDS_RESPONSE);
    const meta = await fetchIndustryBoardsWithMeta();
    expect(meta.stale).toBe(false);
    expect(meta.value.map((b) => b.code)).toEqual(['BK0475', 'BK0428']);
    expect(fs.existsSync(path.join(TEST_CACHE_DIR, 'universe_boards_all.json'))).toBe(true);
  });

  it('远端失败但磁盘有陈旧快照 → 回落 stale:true', async () => {
    seedStaleDisk('universe_boards_all', [{ code: 'BK0475', name: '白酒' }]);
    clearUniverseCache();
    mockedFetchJson.mockRejectedValue(new Error('上游不可用'));
    const meta = await fetchIndustryBoardsWithMeta();
    expect(meta.stale).toBe(true);
    expect(meta.staleAgeMs).toBeGreaterThan(0);
    expect(meta.value).toHaveLength(1);
  });
});
