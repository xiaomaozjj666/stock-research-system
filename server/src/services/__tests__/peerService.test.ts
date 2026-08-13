import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveStockIndustry, buildPeerComparison } from '../peerService.js';

// 路径与 dataService.getData.test.ts 保持一致的模式：从测试文件出发解析到真实模块
vi.mock('../dataFetcher.js', () => ({
  fetchValuationData: vi.fn(async () => ({
    pe: 30,
    pb: 4,
    ps: 5,
    marketCap: 1000,
    currentPrice: 100,
    historicalPE: [],
    peerComparison: [],
  })),
  fetchBoardInfo: vi.fn(async (code: string) => ({ name: `公司${code}`, boardName: '半导体Ⅱ' })),
}));
vi.mock('../../data/industryPeers.js', () => ({
  resolveIndustry: vi.fn((boardName: string | undefined, code: string | undefined) => {
    if (code === '688825') return '半导体';
    if (code === '600519') return '白酒';
    if (boardName && boardName.includes('半导体')) return '半导体';
    return undefined;
  }),
  getPeerCodes: vi.fn((industry: string | undefined) =>
    industry === '半导体' ? ['688981', '603501'] : [],
  ),
}));

import { fetchValuationData, fetchBoardInfo } from '../dataFetcher.js';
import { resolveIndustry, getPeerCodes } from '../../data/industryPeers.js';
const mockFetchValuation = vi.mocked(fetchValuationData);
const mockFetchBoard = vi.mocked(fetchBoardInfo);
const mockResolveIndustry = vi.mocked(resolveIndustry);
const mockGetPeerCodes = vi.mocked(getPeerCodes);

// 恢复 mock 默认实现：此前"代码与板名均无命中"用例把 mock 改成返回 undefined 后不重置，
// 乱序/重跑时会让"优先代码反查"用例误失败
beforeEach(() => {
  mockResolveIndustry.mockImplementation(
    (boardName: string | undefined, code: string | undefined) => {
      if (code === '688825') return '半导体';
      if (code === '600519') return '白酒';
      if (boardName && boardName.includes('半导体')) return '半导体';
      return undefined;
    },
  );
  mockFetchBoard.mockResolvedValue({ name: 'x', boardName: '半导体Ⅱ' });
});

describe('resolveStockIndustry', () => {
  it('优先用代码反查行业（提供 hint 时无需触达网络）', async () => {
    const r = await resolveStockIndustry('688825', '半导体');
    expect(r).toBe('半导体');
    expect(mockFetchBoard).not.toHaveBeenCalled();
  });

  it('传入 industryHint 时同样按代码反查归并', async () => {
    const r = await resolveStockIndustry('600519', '白酒');
    expect(r).toBe('白酒');
  });

  it('代码与板名均无命中时返回空串', async () => {
    mockResolveIndustry.mockReturnValue(undefined);
    mockFetchBoard.mockResolvedValue({ name: '未知', boardName: undefined });
    const r = await resolveStockIndustry('999999', undefined);
    expect(r).toBe('');
  });
});

describe('buildPeerComparison', () => {
  it('按行业取同业代码并实时补齐估值与简称', async () => {
    mockGetPeerCodes.mockReturnValue(['688981', '603501']);
    mockFetchBoard.mockImplementation(async (code: string) => ({
      name: `公司${code}`,
      boardName: '半导体Ⅱ',
    }));
    mockFetchValuation.mockResolvedValue({
      pe: 30,
      pb: 4,
      ps: 5,
      marketCap: 1000,
      currentPrice: 100,
      historicalPE: [],
      peerComparison: [],
    });
    const peers = await buildPeerComparison('688825', '半导体');
    expect(peers).toHaveLength(2);
    expect(peers[0]).toMatchObject({ code: '688981', pe: 30, pb: 4, marketCap: 1000, roe: 0 });
    expect(peers[0].name).toBe('公司688981');
    expect(mockFetchValuation).toHaveBeenCalledTimes(2);
  });

  it('行业无同业代码时返回空数组', async () => {
    mockGetPeerCodes.mockReturnValue([]);
    mockFetchBoard.mockResolvedValue({ name: 'x', boardName: '其他' });
    const peers = await buildPeerComparison('999999', '其他行业');
    expect(peers).toEqual([]);
  });

  it('单个同业拉取失败时跳过该条（不整体失败）', async () => {
    mockGetPeerCodes.mockReturnValue(['688981', '603501']);
    mockFetchBoard.mockImplementation(async (code: string) => ({
      name: `公司${code}`,
      boardName: '半导体Ⅱ',
    }));
    mockFetchValuation.mockRejectedValueOnce(new Error('timeout')).mockResolvedValueOnce({
      pe: 20,
      pb: 3,
      ps: 4,
      marketCap: 800,
      currentPrice: 50,
      historicalPE: [],
      peerComparison: [],
    });
    const peers = await buildPeerComparison('688825', '半导体');
    expect(peers).toHaveLength(1);
    expect(peers[0].code).toBe('603501');
  });
});
