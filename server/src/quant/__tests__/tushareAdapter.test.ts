import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  callTushare,
  fetchStockBasic,
  fetchIndexWeight,
  fetchStockBasicCached,
  fetchIndexWeightCached,
  isTushareConfigured,
} from '../tushareAdapter.js';

const mockedFetch = vi.fn();
vi.stubGlobal('fetch', mockedFetch);

/** 缓存目录重定向 + TTL/时间控制（缓存包装用例需要真实落盘与时间推进） */
let CACHE_DIR = '';
const origCacheDir = process.env.DATA_CACHE_DIR;
const origTtl = process.env.QUANT_TUSHARE_CACHE_TTL_HOURS;

beforeEach(() => {
  mockedFetch.mockReset();
  delete process.env.TUSHARE_TOKEN;
  CACHE_DIR = mkdtempSync(join(tmpdir(), 'srs-tushare-'));
  process.env.DATA_CACHE_DIR = CACHE_DIR;
});
afterEach(() => {
  vi.useRealTimers();
  if (origCacheDir === undefined) delete process.env.DATA_CACHE_DIR;
  else process.env.DATA_CACHE_DIR = origCacheDir;
  if (origTtl === undefined) delete process.env.QUANT_TUSHARE_CACHE_TTL_HOURS;
  else process.env.QUANT_TUSHARE_CACHE_TTL_HOURS = origTtl;
  rmSync(CACHE_DIR, { recursive: true, force: true });
});

describe('callTushare — Tushare Pro HTTP 适配器', () => {
  it('未配置 TUSHARE_TOKEN → 抛错且不发起请求（免费通道不受影响）', async () => {
    await expect(callTushare('stock_basic')).rejects.toThrow('TUSHARE_TOKEN 未配置');
    expect(mockedFetch).not.toHaveBeenCalled();
    expect(isTushareConfigured()).toBe(false);
  });

  it('配置 token → POST JSON（api_name/token/params）并按 fields 转行对象', async () => {
    process.env.TUSHARE_TOKEN = 'tok-test';
    mockedFetch.mockResolvedValue({
      json: async () => ({
        code: 0,
        msg: null,
        data: {
          fields: ['ts_code', 'name', 'list_status', 'delist_date'],
          items: [
            ['600519.SH', '贵州茅台', 'L', null],
            ['000003.SH', 'PT金田A', 'D', '2002-06-14'],
          ],
        },
      }),
    });
    const rows = await fetchStockBasic('D');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      tsCode: '600519.SH',
      name: '贵州茅台',
      listStatus: 'L',
      listDate: null,
      delistDate: null,
      industry: null,
    });
    expect(rows[1].listStatus).toBe('D');
    expect(rows[1].delistDate).toBe('2002-06-14');
    // 请求体结构：POST JSON + token + params
    const [url, init] = mockedFetch.mock.calls[0];
    expect(url).toContain('api.tushare.pro');
    const body = JSON.parse(init.body);
    expect(body.api_name).toBe('stock_basic');
    expect(body.token).toBe('tok-test');
    expect(body.params).toEqual({ list_status: 'D' });
  });

  it('上游错误码 → 抛出并带 code/msg', async () => {
    process.env.TUSHARE_TOKEN = 'tok-test';
    mockedFetch.mockResolvedValue({
      json: async () => ({ code: 40201, msg: '抱歉，您每天最多访问该接口1次', data: null }),
    });
    await expect(fetchIndexWeight('000300.SH', '20240102')).rejects.toThrow(/40201/);
  });
});

describe('Cached 包装 — 频控纪律（免费积分 stock_basic 实测 1 次/小时）', () => {
  /** 单行全量主表夹具 */
  function okBody() {
    return {
      json: async () => ({
        code: 0,
        msg: null,
        data: {
          fields: ['ts_code', 'name', 'list_status', 'list_date', 'delist_date', 'industry'],
          items: [
            ['600519.SH', '贵州茅台', 'L', '20010827', null, '白酒'],
            ['000003.SH', 'PT金田A', 'D', '19910703', '2002-06-14', null],
          ],
        },
      }),
    } as unknown as Response;
  }

  it('24h 缓存：两次调用只打一次上游；并发去重共享同一 promise', async () => {
    process.env.TUSHARE_TOKEN = 'tok-test';
    mockedFetch.mockResolvedValue(okBody());
    const a = await fetchStockBasicCached();
    const b = await fetchStockBasicCached();
    expect(a).toHaveLength(2);
    expect(b).toEqual(a);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it('缓存过期 + 上游频控失败 → 回落陈旧缓存（stale 兜底），无缓存时抛错', async () => {
    vi.useFakeTimers();
    process.env.TUSHARE_TOKEN = 'tok-test';
    mockedFetch.mockResolvedValue(okBody());
    await fetchStockBasicCached(); // 落盘缓存（T0）
    expect(mockedFetch).toHaveBeenCalledTimes(1);

    // 推进 25 小时：缓存过期 → 下一次调用必然重打上游
    vi.setSystemTime(new Date(Date.now() + 25 * 3600 * 1000));
    mockedFetch.mockResolvedValue({
      json: async () => ({ code: 40203, msg: '频率超限(1次/小时)', data: null }),
    });
    const stale = await fetchStockBasicCached();
    expect(stale).toHaveLength(2); // 频控失败，但陈旧缓存兜底成功
    expect(mockedFetch).toHaveBeenCalledTimes(2);

    // 无任何缓存的新 key：上游失败必须如实抛错（不伪造数据）
    delete process.env.QUANT_TUSHARE_CACHE_TTL_HOURS;
    await expect(fetchIndexWeightCached('000300.SH', '20260831')).rejects.toThrow(/40203/);
  });

  it('TTL 显式置 0 → 关闭缓存，每次直连（测试旁路口径）', async () => {
    process.env.TUSHARE_TOKEN = 'tok-test';
    process.env.QUANT_TUSHARE_CACHE_TTL_HOURS = '0';
    mockedFetch.mockResolvedValue(okBody());
    await fetchStockBasicCached();
    await fetchStockBasicCached();
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });
});
