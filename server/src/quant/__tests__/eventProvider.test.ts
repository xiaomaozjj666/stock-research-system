import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fetchBuybackEvents,
  fetchDividendEvents,
  fetchStockEvents,
  fetchUnlockEvents,
} from '../eventProvider.js';

/**
 * 事件数据源单测：东财 datacenter JSON 解析、缓存命中与关闭、失败抛错由
 * fetchStockEvents 降级。
 *
 * **夹具为 2026-09-06 真实 API 响应裁剪（ground truth）**：
 * 贵州茅台 600519（分红）、五粮液 000858 / 澜起科技 688008（回购）、
 * 三未信安 688489（解禁）、濮耐股份 002225（停止实施回购）。字段口径以此为准——
 * 上游改字段时，先用真实 curl 核对本文件夹具再改解析。
 * 缓存目录经 DATA_CACHE_DIR 重定向到进程专属临时目录。
 */

let CACHE_DIR = '';
const origCacheDir = process.env.DATA_CACHE_DIR;
const origTtl = process.env.QUANT_EVENT_CACHE_TTL_HOURS;

beforeEach(() => {
  CACHE_DIR = mkdtempSync(join(tmpdir(), 'srs-event-provider-'));
  process.env.DATA_CACHE_DIR = CACHE_DIR;
  delete process.env.QUANT_EVENT_CACHE_TTL_HOURS;
});
afterEach(() => {
  vi.restoreAllMocks();
  if (origCacheDir === undefined) delete process.env.DATA_CACHE_DIR;
  else process.env.DATA_CACHE_DIR = origCacheDir;
  if (origTtl === undefined) delete process.env.QUANT_EVENT_CACHE_TTL_HOURS;
  else process.env.QUANT_EVENT_CACHE_TTL_HOURS = origTtl;
  rmSync(CACHE_DIR, { recursive: true, force: true });
});

/** 东财 datacenter v1/get 响应体 */
function dcBody(rows: Record<string, unknown>[]) {
  return {
    json: async () => ({ success: true, result: { pages: 1, count: rows.length, data: rows } }),
  } as unknown as Response;
}

/** RPT_SHAREBONUS_DET @600519（真实裁剪）：10派280.2423 元，DIVIDENT_RATIO=0.0231 为 0-1 小数 */
const DIV_ROWS = [
  {
    SECUCODE: '600519.SH',
    SECURITY_NAME_ABBR: '贵州茅台',
    SECURITY_CODE: '600519',
    PRETAX_BONUS_RMB: 280.2423,
    PLAN_NOTICE_DATE: '2026-04-17 00:00:00',
    EQUITY_RECORD_DATE: '2026-06-25 00:00:00',
    EX_DIVIDEND_DATE: '2026-06-26 00:00:00',
    REPORT_DATE: '2025-12-31 00:00:00',
    ASSIGN_PROGRESS: '实施分配',
    IMPL_PLAN_PROFILE: '10派280.2423元(含税)',
    NOTICE_DATE: '2026-06-22 00:00:00',
    DIVIDENT_RATIO: 0.023120394357,
  },
  {
    // 预披露（不分配）：PRETAX_BONUS_RMB / DIVIDENT_RATIO 均空 → 过滤
    SECUCODE: '600519.SH',
    SECURITY_CODE: '600519',
    PRETAX_BONUS_RMB: null,
    PLAN_NOTICE_DATE: '2026-04-17 00:00:00',
    EX_DIVIDEND_DATE: null,
    REPORT_DATE: '2026-06-30 00:00:00',
    ASSIGN_PROGRESS: '预披露',
    DIVIDENT_RATIO: null,
  },
];

/** RPTA_WEB_GETHGLIST_NEW（真实裁剪，filter=(DIM_SCODE=...)） */
const BUY_ROWS = [
  {
    // 五粮液 2026 回购：金额上限 100 亿，公告前一日总市值 38170.80 亿
    REPURCODE: '15878',
    DIM_SCODE: '000858',
    SECURITYSHORTNAME: '五粮液',
    DIM_DATE: '2026-04-30 00:00:00',
    DIM_TRADEDATE: '2026-04-29 00:00:00',
    NOTICEDATE: '2026-09-03 00:00:00',
    UPDATEDATE: '2026-07-16 00:00:00',
    REPURSTARTDATE: '2026-05-18 00:00:00',
    REPURPROGRESS: '004',
    REPURAMOUNTLIMIT: 10000000000,
    REPURAMOUNTLOWER: 8000000000,
    REPURNUMCAP: null,
    REPURNUMLOWER: null,
    AGSZBHXS: 381708026870.94,
    ZSZ: 381717331211.7,
    ZJSZBL: null,
    REPURAMOUNT: 1100713439.77,
    REPURNUM: 14707406,
  },
  {
    // 澜起科技 2025 回购（按数量规划）：ZJSZBL=占比中值（%）
    REPURCODE: '14849',
    DIM_SCODE: '688008',
    SECURITYSHORTNAME: '澜起科技',
    DIM_DATE: '2025-06-21 00:00:00',
    NOTICEDATE: '2025-09-20 00:00:00',
    UPDATEDATE: '2025-09-20 00:00:00',
    REPURSTARTDATE: null,
    REPURPROGRESS: '006',
    REPURAMOUNTLIMIT: 400000000,
    REPURAMOUNTLOWER: 200000000,
    REPURNUMCAP: 3389800,
    REPURNUMLOWER: 1694900,
    AGSZBHXS: 93380460998.61,
    ZSZ: 93380460998.61,
    ZJSZBL: 0.222080173178,
  },
  {
    // 停止实施（007）：公告后从未实施（REPURAMOUNT null）——公告即事件，不被过滤
    REPURCODE: '15815',
    DIM_SCODE: '002225',
    SECURITYSHORTNAME: '濮耐股份',
    DIM_DATE: '2026-04-29 00:00:00',
    NOTICEDATE: null,
    UPDATEDATE: '2026-04-29 00:00:00',
    REPURSTARTDATE: null,
    REPURPROGRESS: '007',
    REPURAMOUNTLIMIT: 200000000,
    AGSZBHXS: 5000000000,
    ZJSZBL: null,
  },
];

/** RPT_LIFT_STAGE @688489（真实裁剪）：FREE_RATIO 为 0-1 小数，数量/市值单位为万股/万元 */
const UNLOCK_ROWS = [
  {
    SECUCODE: '688489.SH',
    SECURITY_CODE: '688489',
    SECURITY_NAME_ABBR: '三未信安',
    FREE_DATE: '2023-06-02 00:00:00',
    CURRENT_FREE_SHARES: 110.3339,
    LIFT_MARKET_CAP: 8492.400283,
    FREE_SHARES_TYPE: '首发机构配售股份',
    FREE_RATIO: 0.043625801047,
    TOTAL_RATIO: 0.0096878149,
  },
  {
    SECUCODE: '688489.SH',
    SECURITY_CODE: '688489',
    FREE_DATE: '2023-12-04 00:00:00',
    CURRENT_FREE_SHARES: 2425.3724,
    LIFT_MARKET_CAP: 123936.52964,
    FREE_RATIO: 0.490892995403,
    TOTAL_RATIO: 0.212958654363,
  },
];

describe('fetchDividendEvents — 解析与缓存', () => {
  it('解析预案公告日/除权日/每10股股利/股息率（0-1 小数 ×100）；不分配行过滤', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(dcBody(DIV_ROWS));
    const rows = await fetchDividendEvents('600519');
    expect(rows).toHaveLength(1);
    expect(rows[0].announceDate).toBe('2026-04-17');
    expect(rows[0].exDate).toBe('2026-06-26');
    expect(rows[0].per10Cash).toBe(280.2423);
    // 0.023120394357 × 100 = 2.3120394357 → 保留 4 位小数
    expect(rows[0].dividendYieldPct).toBe(2.312);
  });

  it('TTL 内命中缓存 → 不再发起网络请求', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(dcBody(DIV_ROWS));
    const first = await fetchDividendEvents('600519');
    const second = await fetchDividendEvents('600519');
    expect(second).toEqual(first);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('QUANT_EVENT_CACHE_TTL_HOURS=0 → 关闭缓存，每次都请求', async () => {
    process.env.QUANT_EVENT_CACHE_TTL_HOURS = '0';
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(dcBody(DIV_ROWS));
    await fetchDividendEvents('600519');
    await fetchDividendEvents('600519');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('网络失败 → 抛错（由 fetchStockEvents 降级）', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    await expect(fetchDividendEvents('600519')).rejects.toThrow('network down');
  });

  it('报表不存在（真实踩坑：RPT_REPURCHASE_PLAN 即如此）→ 抛结构异常', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      json: async () => ({
        version: null,
        result: null,
        success: false,
        message: '报表配置不存在,RPT_REPURCHASE_PLAN',
        code: 9501,
      }),
    } as unknown as Response);
    await expect(fetchDividendEvents('600519')).rejects.toThrow(/结构异常|报表配置不存在/);
  });

  it('code 9201「返回数据为空」→ 合法空结果（实测：600519 无解禁记录）', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      json: async () => ({
        version: null,
        result: null,
        success: false,
        message: '返回数据为空',
        code: 9201,
      }),
    } as unknown as Response);
    expect(await fetchDividendEvents('600519')).toEqual([]);
  });

  it('success=true 但 result=null → 合法空结果', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      json: async () => ({ success: true, result: null }),
    } as unknown as Response);
    expect(await fetchDividendEvents('600519')).toEqual([]);
  });
});

describe('fetchBuybackEvents — 解析', () => {
  it('解析 DIM_DATE 公告日/金额上限/公告前一日总市值/进度码；停止实施（007）不排除', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(dcBody(BUY_ROWS));
    const rows = await fetchBuybackEvents('000858');
    // 停止实施的方案也是真实的公告事件，不排除
    expect(rows).toHaveLength(3);
    expect(rows[0].announceDate).toBe('2026-04-30');
    expect(rows[0].startDate).toBe('2026-05-18');
    expect(rows[0].planAmountHighYuan).toBe(10000000000);
    expect(rows[0].preAnnounceCapYuan).toBe(381708026870.94);
    expect(rows[0].planRatioMidPct).toBeNull();
    expect(rows[0].progress).toBe('004');
  });

  it('同日重复披露（同一方案多次披露）→ 保留数值最大的一条', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      dcBody([
        {
          REPURCODE: 'a',
          DIM_DATE: '2026-03-10 00:00:00',
          REPURAMOUNTLIMIT: 100,
          REPURPROGRESS: '003',
        },
        {
          REPURCODE: 'b',
          DIM_DATE: '2026-03-10 00:00:00',
          REPURAMOUNTLIMIT: 300,
          REPURPROGRESS: '004',
        },
      ]),
    );
    const rows = await fetchBuybackEvents('000858');
    expect(rows).toHaveLength(1);
    expect(rows[0].planAmountHighYuan).toBe(300);
  });
});

describe('fetchUnlockEvents — 解析', () => {
  it('FREE_RATIO 为 0-1 小数 → ×100 转百分比；数量/市值单位为万股/万元', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(dcBody(UNLOCK_ROWS));
    const rows = await fetchUnlockEvents('688489');
    expect(rows).toHaveLength(2);
    expect(rows[0].freeDate).toBe('2023-06-02');
    expect(rows[0].ratioOfFloatPct).toBe(4.3626); // 0.043625801047 × 100
    expect(rows[1].ratioOfFloatPct).toBe(49.0893); // 0.490892995403 × 100
    expect(rows[0].sharesWan).toBe(110.3339);
    expect(rows[0].marketCapWan).toBe(8492.400283);
  });
});

describe('fetchStockEvents — 单类失败降级', () => {
  it('任一事件源失败只降级该类为 []，其余两类正常返回', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('RPT_LIFT_STAGE')) throw new Error('unlock down');
      if (url.includes('RPT_SHAREBONUS_DET')) return dcBody(DIV_ROWS);
      if (url.includes('RPTA_WEB_GETHGLIST_NEW')) return dcBody(BUY_ROWS);
      throw new Error(`unexpected url: ${url}`);
    });
    const bundle = await fetchStockEvents('600519');
    expect(bundle.dividend).toHaveLength(1);
    expect(bundle.buyback).toHaveLength(3);
    expect(bundle.unlock).toEqual([]);
  });
});
