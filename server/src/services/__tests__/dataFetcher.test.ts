import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

// 隔离网络：dataFetcher 的所有 fetch* 函数都经由 fetchJsonWithTimeout -> fetchJson。
// 直接 mock fetchJson 即可驱动每个解析分支，无需真实网络。
// 注意：本测试文件位于 __tests__/ 子目录，故相对路径需多上一级（../../utils/http.js）。
vi.mock('../../utils/http.js', () => ({
  fetchJson: vi.fn(),
}));

import { fetchJson } from '../../utils/http.js';
import {
  fetchStockInfo,
  fetchFinancialData,
  fetchValuationData,
  fetchBoardInfo,
  clearValueAnalysisCache,
  toNum,
  yuanToYi,
  toPercent,
} from '../dataFetcher.js';

const mockFetchJson = vi.mocked(fetchJson);

// 备份原始 fetch，用于新浪文本 fetch 的 mock
const originalFetch = globalThis.fetch;

beforeEach(() => {
  mockFetchJson.mockReset();
  clearValueAnalysisCache();
  // 新浪文本 fetch 兜底：mock 返回无名称，使 fetchStockInfo 走完回退链
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    text: () => Promise.resolve('var hq_str_sh600519=","'),
  });
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe('数值工具（toNum / yuanToYi / toPercent）', () => {
  it('toNum 处理 null/undefined/横线/NaN', () => {
    expect(toNum(null)).toBe(0);
    expect(toNum(undefined)).toBe(0);
    expect(toNum('-')).toBe(0);
    expect(toNum('abc')).toBe(0);
    expect(toNum('12.5')).toBe(12.5);
    expect(toNum(42)).toBe(42);
  });

  it('yuanToYi 元 -> 亿元，保留两位并截断小数', () => {
    expect(yuanToYi(0)).toBe(0);
    expect(yuanToYi(1e8)).toBe(1);
    expect(yuanToYi(1234567890)).toBe(12.35);
  });

  it('toPercent 比率已是百分比形式时不再 ×100（回归：105 -> 105 而非 10500）', () => {
    expect(toPercent(0)).toBe(0);
    expect(toPercent(91.5)).toBe(91.5);
    expect(toPercent(105)).toBe(105);
    expect(toPercent(0.915)).toBe(91.5); // 小数形式才 ×100
    expect(toPercent('-')).toBe(0);
  });
});

describe('fetchStockInfo', () => {
  it('东方财富返回含名称时直接返回', async () => {
    mockFetchJson.mockResolvedValue({
      rc: 0,
      data: { f57: '600519', f58: '贵州茅台', f127: '白酒' },
    });
    const info = await fetchStockInfo('600519');
    expect(info).toMatchObject({ code: '600519', name: '贵州茅台', industry: '白酒', market: '上交所主板' });
  });

  it('深交所代码市场标记为深交所主板', async () => {
    mockFetchJson.mockResolvedValue({
      rc: 0,
      data: { f57: '000001', f58: '平安银行', f127: '银行' },
    });
    const info = await fetchStockInfo('000001');
    expect(info.market).toBe('深交所主板');
  });

  it('两个数据源均无名称时抛出', async () => {
    mockFetchJson
      .mockResolvedValueOnce({ rc: 0, data: { f57: '600519', f58: '', f127: '' } }) // 东财无名称
      .mockResolvedValueOnce({}); // 新浪解析失败
    await expect(fetchStockInfo('600519')).rejects.toThrow(/无法获取股票基本信息/);
  });
});

describe('fetchFinancialData', () => {
  const record = (reportDate: string) => ({
    REPORT_DATE: reportDate,
    TOTALOPERATEREVE: 1e9, // 10 亿
    PARENTNETPROFIT: 1e8, // 1 亿
    XSMLL: 91.5,
    XSJLL: 50,
    ROEJQ: 25,
    MGJYXJJE: 2,
    TOTAL_SHARE: 1e9,
    EPSJB: 1.5,
    TOTAL_ASSETS_PK: 5e9, // 50 亿
    LIABILITY: 2e9, // 20 亿
    TOTAL_EQUITY_PK: 3e9, // 30 亿
    YSZKZZTS: 30,
    CHZZTS: 60,
    ZCFZL: 40,
  });

  it('东方财富主数据源：解析多年并正确换算量纲', async () => {
    mockFetchJson.mockResolvedValue({
      success: true,
      result: { data: [record('2024-12-31'), record('2023-12-31')] },
    });
    const f = await fetchFinancialData('600519');
    expect(f.years).toEqual(['2023', '2024']); // 按年份升序
    expect(f.revenue[0]).toBe(10); // 2023
    expect(f.revenue[1]).toBe(10); // 2024
    expect(f.netProfit[0]).toBe(1);
    expect(f.grossMargin[0]).toBe(91.5);
    expect(f.roe[0]).toBe(25);
    expect(f.debtRatio[0]).toBe(40);
    expect(f.operatingCashFlow[0]).toBe(20); // 2 * 1e9 / 1e8
    expect(f.accountsReceivable[0]).toBeCloseTo(0.82, 2);
    expect(f.inventory[0]).toBeCloseTo(0.14, 2);
    expect(f.dataQuality?.missingFields).toContain('goodwill');
  });

  it('主数据源无数据时回退到单年快照', async () => {
    mockFetchJson
      .mockResolvedValueOnce({ success: false, result: { data: [] } }) // 主源失败
      .mockResolvedValueOnce({ data: { f173: 1e9, f187: 1e8, f188: 80, f190: 40, f191: 20, f192: 1, f193: 5e9, f162: 50 } }); // push2 兜底
    const f = await fetchFinancialData('600519');
    expect(f.years).toHaveLength(1);
    expect(f.revenue[0]).toBe(10);
    expect(f.grossMargin[0]).toBe(80);
    expect(f.dataQuality?.missingFields).toContain('goodwill');
  });

  it('两个数据源均无数据抛出', async () => {
    mockFetchJson
      .mockResolvedValueOnce({ success: false, result: { data: [] } })
      .mockResolvedValueOnce({ data: null });
    await expect(fetchFinancialData('600519')).rejects.toThrow(/无法获取财务数据/);
  });
});

describe('fetchValuationData', () => {
  it('优先使用 datacenter 估值分析（量纲已正确）', async () => {
    mockFetchJson.mockResolvedValue({
      result: {
        data: [
          {
            CLOSE_PRICE: 1500,
            PE_TTM: 30,
            PB_MRQ: 8,
            TOTAL_MARKET_CAP: 1.5e12, // 1.5 万亿 -> 15000 亿
            SECURITY_NAME_ABBR: '贵州茅台',
            BOARD_NAME: '白酒',
          },
        ],
      },
    });
    const v = await fetchValuationData('600519');
    expect(v.currentPrice).toBe(1500);
    expect(v.pe).toBe(30);
    expect(v.pb).toBe(8);
    expect(v.marketCap).toBe(15000);
    expect(v.ps).toBe(0);
    expect(v.historicalPE).toEqual([]);
  });

  it('datacenter 不可达时回退到 push2 行情（价格字段以分计需 /100）', async () => {
    mockFetchJson
      .mockResolvedValueOnce({ result: { data: [] } }) // datacenter 空
      .mockResolvedValueOnce({
        data: {
          f43: 150000, // 1500.00 元（分）
          f167: 30,
          f164: 8,
          f116: 1.5e12, // 市值（元）
          f173: 1e9, // 营收（元）
          f162: 50,
        },
      });
    const v = await fetchValuationData('600519');
    expect(v.currentPrice).toBe(1500); // 150000 / 100
    expect(v.pe).toBe(30);
    expect(v.pb).toBe(8);
    expect(v.marketCap).toBe(15000);
    expect(v.ps).toBeCloseTo(1500, 2); // 15000 / 10（市值/营收，量级正确即可）
    expect(v.historicalPE).toHaveLength(6); // 确定性伪随机历史 PE
    expect(v.historicalPE.every((h) => h.isEstimated)).toBe(true);
  });

  it('两个数据源均无有效价格抛出', async () => {
    mockFetchJson
      .mockResolvedValueOnce({ result: { data: [] } })
      .mockResolvedValueOnce({ data: { f43: 0 } }); // push2 价格为 0
    await expect(fetchValuationData('600519')).rejects.toThrow(/无法获取估值数据/);
  });
});

describe('fetchBoardInfo', () => {
  it('返回证券简称与板块名', async () => {
    mockFetchJson.mockResolvedValue({
      result: { data: [{ SECURITY_NAME_ABBR: '长鑫科技', BOARD_NAME: '半导体' }] },
    });
    const b = await fetchBoardInfo('688825');
    expect(b).toEqual({ name: '长鑫科技', boardName: '半导体' });
  });

  it('无结果时返回 null', async () => {
    mockFetchJson.mockResolvedValue({ result: { data: [] } });
    expect(await fetchBoardInfo('688825')).toBeNull();
  });
});
