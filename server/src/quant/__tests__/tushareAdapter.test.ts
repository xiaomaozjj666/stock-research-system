import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  callTushare,
  fetchStockBasic,
  fetchIndexWeight,
  isTushareConfigured,
} from '../tushareAdapter.js';

const mockedFetch = vi.fn();
vi.stubGlobal('fetch', mockedFetch);

beforeEach(() => {
  mockedFetch.mockReset();
  delete process.env.TUSHARE_TOKEN;
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
