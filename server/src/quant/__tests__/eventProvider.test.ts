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
 * 事件数据源单测：东财 datacenter JSON 解析（字段候选/日期归一/比例口径）、
 * 缓存命中与关闭、失败抛错由 fetchStockEvents 降级。
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

const DIV_ROWS = [
  {
    SECURITY_CODE: '600519',
    REPORT_DATE: '2025-12-31 00:00:00',
    PLAN_NOTICE_DATE: '2026-04-25 00:00:00',
    NOTICE_DATE: '2026-06-10 00:00:00',
    EX_DIVIDEND_DATE: '2026-06-18 00:00:00',
    PRETAX_BONUS_RMB: 48,
    DIVIDENT_RATIO: 3.2,
  },
  {
    SECURITY_CODE: '600519',
    REPORT_DATE: '2025-06-30 00:00:00',
    PLAN_NOTICE_DATE: '2025-08-28 00:00:00',
    EX_DIVIDEND_DATE: null,
    PRETAX_BONUS_RMB: 0,
    DIVIDENT_RATIO: 0,
  },
];

const BUY_ROWS = [
  {
    SECURITY_CODE: '000858',
    UPDATE_DATE: '2026-03-10 00:00:00',
    START_DATE: '2026-04-01 00:00:00',
    RATIO_HIGH: 2.5,
    REPURCHASE_AMOUNT_HIGH: 5e8,
    PROGRESS: '实施中',
  },
  {
    SECURITY_CODE: '000858',
    UPDATE_DATE: '2025-01-15 00:00:00',
    START_DATE: null,
    RATIO_HIGH: 1,
    REPURCHASE_AMOUNT_HIGH: 1e8,
    PROGRESS: '停止实施',
  },
];

const UNLOCK_ROWS = [
  {
    SECURITY_CODE: '688489',
    FREE_DATE: '2026-08-10 00:00:00',
    FREE_RATIO: 1,
    CURRENT_FREE_SHARES: 1e8,
    LIFT_MARKET_CAP: 1.2e9,
  },
  {
    SECURITY_CODE: '688489',
    FREE_DATE: '2025-08-10 00:00:00',
    FREE_RATIO: 0.0205,
    CURRENT_FREE_SHARES: 2e6,
    LIFT_MARKET_CAP: 3e7,
  },
];

describe('fetchDividendEvents — 解析与缓存', () => {
  it('解析预案公告日/除权日/每10股股利/股息率；日期归一到 YYYY-MM-DD；不分配行过滤', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(dcBody(DIV_ROWS));
    const rows = await fetchDividendEvents('600519');
    expect(rows).toHaveLength(1);
    expect(rows[0].announceDate).toBe('2026-04-25');
    expect(rows[0].exDate).toBe('2026-06-18');
    expect(rows[0].per10Cash).toBe(48);
    expect(rows[0].dividendYieldPct).toBe(3.2);
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

  it('result 为 null 且 success=false → 抛结构异常', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      json: async () => ({ success: false, message: '查询不到数据', result: null }),
    } as unknown as Response);
    await expect(fetchDividendEvents('600519')).rejects.toThrow(/结构异常|查询不到/);
  });

  it('success=true 但 result=null → 合法空结果', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      json: async () => ({ success: true, result: null }),
    } as unknown as Response);
    expect(await fetchDividendEvents('600519')).toEqual([]);
  });
});

describe('fetchBuybackEvents — 解析', () => {
  it('解析公告日/比例上限/进度；停止实施的方案排除', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(dcBody(BUY_ROWS));
    const rows = await fetchBuybackEvents('000858');
    expect(rows).toHaveLength(1);
    expect(rows[0].announceDate).toBe('2026-03-10');
    expect(rows[0].startDate).toBe('2026-04-01');
    expect(rows[0].ratioHighPct).toBe(2.5);
    expect(rows[0].amountHighYuan).toBe(5e8);
    expect(rows[0].progress).toBe('实施中');
  });

  it('同日重复披露 → 保留比例最大的一条', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      dcBody([
        {
          SECURITY_CODE: 'x',
          UPDATE_DATE: '2026-03-10 00:00:00',
          RATIO_HIGH: 1,
          PROGRESS: '董事会通过',
        },
        {
          SECURITY_CODE: 'x',
          UPDATE_DATE: '2026-03-10 00:00:00',
          RATIO_HIGH: 3,
          PROGRESS: '实施中',
        },
      ]),
    );
    const rows = await fetchBuybackEvents('000858');
    expect(rows).toHaveLength(1);
    expect(rows[0].ratioHighPct).toBe(3);
  });
});

describe('fetchUnlockEvents — 解析', () => {
  it('FREE_RATIO 为 0-1 小数 → ×100 转百分比；无解禁日/无比例的行过滤', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(dcBody(UNLOCK_ROWS));
    const rows = await fetchUnlockEvents('688489');
    expect(rows).toHaveLength(2);
    expect(rows[0].freeDate).toBe('2026-08-10');
    expect(rows[0].ratioOfFloatPct).toBe(100); // 全流通解禁：比例恰为 1.0 → 100%
    expect(rows[1].ratioOfFloatPct).toBe(2.05);
    expect(rows[0].shares).toBe(1e8);
    expect(rows[0].marketCapYuan).toBe(1.2e9);
  });
});

describe('fetchStockEvents — 单类失败降级', () => {
  it('任一事件源失败只降级该类为 []，其余两类正常返回', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('RPT_LIFT_STAGE')) throw new Error('unlock down');
      if (url.includes('RPT_SHAREBONUS_DET')) return dcBody(DIV_ROWS);
      if (url.includes('RPT_REPURCHASE_PLAN')) return dcBody(BUY_ROWS);
      throw new Error(`unexpected url: ${url}`);
    });
    const bundle = await fetchStockEvents('600519');
    expect(bundle.dividend).toHaveLength(1);
    expect(bundle.buyback).toHaveLength(1);
    expect(bundle.unlock).toEqual([]);
  });
});
