import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fetchJson } from '../../utils/http.js';
import {
  fetchIndustryBoards,
  fetchBoardConstituents,
  isValidBoardCode,
  clearUniverseCache,
} from '../universeProvider.js';

vi.mock('../../utils/http.js', () => ({ fetchJson: vi.fn() }));
const mockedFetchJson = vi.mocked(fetchJson);

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
