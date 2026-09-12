import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchMarginSeries, marginFactorValues } from '../marginProvider.js';
import type { MarginRow } from '../marginProvider.js';

/**
 * 两融数据源单测：datacenter JSON 解析（字段口径以 2026-09-12 真实响应为准）、
 * 因子取值的 T+1 披露纪律（t 日只用严格早于 t 的行）、20 日变化率基期。
 * 缓存目录经 DATA_CACHE_DIR 重定向到进程专属临时目录。
 */

let CACHE_DIR = '';
const origCacheDir = process.env.DATA_CACHE_DIR;
const origTtl = process.env.QUANT_MARGIN_CACHE_TTL_HOURS;

beforeEach(() => {
  CACHE_DIR = mkdtempSync(join(tmpdir(), 'srs-margin-provider-'));
  process.env.DATA_CACHE_DIR = CACHE_DIR;
  delete process.env.QUANT_MARGIN_CACHE_TTL_HOURS;
});
afterEach(() => {
  vi.restoreAllMocks();
  if (origCacheDir === undefined) delete process.env.DATA_CACHE_DIR;
  else process.env.DATA_CACHE_DIR = origCacheDir;
  if (origTtl === undefined) delete process.env.QUANT_MARGIN_CACHE_TTL_HOURS;
  else process.env.QUANT_MARGIN_CACHE_TTL_HOURS = origTtl;
  rmSync(CACHE_DIR, { recursive: true, force: true });
});

/** 东财 datacenter v1/get 响应体 */
function dcBody(rows: Record<string, unknown>[]) {
  return {
    json: async () => ({ success: true, result: { pages: 1, count: rows.length, data: rows } }),
  } as unknown as Response;
}

/** 真实响应裁剪（RPTA_WEB_RZRQ_GGMX @600036，2026-09-11 / 09-10 两日） */
const MARGIN_ROWS = [
  {
    DATE: '2026-09-11 00:00:00',
    MARKET: '融资融券_沪证',
    SCODE: '600036',
    SECNAME: '招商银行',
    RZYE: 9815585112,
    RZJME: -3540406,
    RZRQYE: 10217573933.6,
    RZYEZB: 1.15070413,
    SZ: 853006852139.15,
    SECUCODE: '600036.SH',
  },
  {
    DATE: '2026-09-10 00:00:00',
    SCODE: '600036',
    RZYE: 9819125519,
    RZJME: 12345678,
    RZYEZB: 1.1511198,
    SZ: 853006852139.15,
  },
];

describe('fetchMarginSeries — 两融日度序列解析', () => {
  it('解析 DATE/RZYE/RZYEZB/RZJME，降序响应转升序', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(dcBody(MARGIN_ROWS));
    const rows = await fetchMarginSeries('600036');
    expect(rows.map((r) => r.date)).toEqual(['2026-09-10', '2026-09-11']);
    expect(rows[1]).toEqual({
      date: '2026-09-11',
      balance: 9815585112,
      balancePct: 1.15070413,
      netBuy: -3540406,
    });
  });

  it('无数据（9201）返回空数组，非法行（余额缺失）被跳过', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      json: async () => ({ success: false, code: 9201, message: '返回数据为空' }),
    } as unknown as Response);
    expect(await fetchMarginSeries('600000')).toEqual([]);

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      dcBody([{ DATE: '2026-09-11 00:00:00', SCODE: '600036' }]),
    );
    expect(await fetchMarginSeries('600036')).toEqual([]);
  });
});

describe('marginFactorValues — PIT 取值（T+1 披露纪律）', () => {
  // 22 行两融序列：余额 100 + i（便于手算变化率），占比 1 + i*0.1
  const rows: MarginRow[] = Array.from({ length: 22 }, (_, i) => ({
    date: `2024-01-${String(i + 1).padStart(2, '0')}`,
    balance: 100 + i,
    balancePct: 1 + i * 0.1,
    netBuy: i,
  }));

  it('t 日只用严格早于 t 的行：首日无前值 → null；次日取到 T-1 行', () => {
    const v = marginFactorValues(rows, ['2024-01-01', '2024-01-02', '2024-01-23']);
    // 2024-01-01 无更早行
    expect(v.mg_balance_pct[0]).toBeNull();
    expect(v.mg_balance_chg20[0]).toBeNull();
    // 2024-01-02 → 只能用 01-01 行（balance=100, pct=1.0）
    expect(v.mg_balance_pct[1]).toBe(1.0);
    // 2024-01-23 → 只能用 01-22 行（index 21，pct=1+21*0.1=3.1）
    expect(v.mg_balance_pct[2]).toBeCloseTo(3.1, 10);
  });

  it('20 日变化率以两融行自身 20 行前为基期；不足 20 行为 null', () => {
    const v = marginFactorValues(rows, ['2024-01-23']);
    // 可用行 index=21，基期 index=1（balance=101）→ 121/101 − 1
    expect(v.mg_balance_chg20[0]).toBeCloseTo(121 / 101 - 1, 10);
    const short = marginFactorValues(rows.slice(0, 15), ['2024-01-23']);
    expect(short.mg_balance_chg20[0]).toBeNull(); // index 14 < 20
  });

  it('缺口日对齐：bar 日无对应两融行时回落到最近早行', () => {
    // 两融行到 01-22 为止，bar 日 01-25 应仍用 01-22 行
    const v = marginFactorValues(rows, ['2024-01-25']);
    expect(v.mg_balance_pct[0]).toBeCloseTo(3.1, 10);
  });
});
