import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchOHLCVData, getBenchmarkCurve, marketOf, resolveSecid } from '../dataProvider.js';
import type { OHLCVData } from '../types.js';

/**
 * dataProvider 补充测试：覆盖 K 线拉取的缓存/解析/降级路径与基准曲线。
 * 缓存目录经 DATA_CACHE_DIR 重定向到进程专属临时目录（dataProvider.ts 现支持 env 重定向），
 * 不再写真实 quant/cache，也不依赖 afterEach 删除（残留由 OS 清理，杜绝跨运行污染）。
 */
let CACHE_DIR = '';

const origCacheDir = process.env.DATA_CACHE_DIR;
beforeAll(() => {
  CACHE_DIR = mkdtempSync(join(tmpdir(), 'srs-quant-cache-'));
  process.env.DATA_CACHE_DIR = CACHE_DIR;
});
afterAll(() => {
  if (origCacheDir === undefined) delete process.env.DATA_CACHE_DIR;
  else process.env.DATA_CACHE_DIR = origCacheDir;
  rmSync(CACHE_DIR, { recursive: true, force: true });
});

/** 用例专属的缓存键，避免与真实数据冲突 */
const cacheFileFor = (code: string, start: string, end: string) =>
  path.join(CACHE_DIR, `${code}_${start}_${end}.json`);

describe('fetchOHLCVData — 缓存路径', () => {
  const code = '999001';
  const start = '2024-01-01';
  const end = '2024-01-31';

  afterEach(() => {
    fs.rmSync(cacheFileFor(code, start, end), { force: true });
    vi.restoreAllMocks();
  });

  it('12 小时内的缓存命中直接返回，不触发网络请求', async () => {
    const cached: OHLCVData[] = [
      { date: '2024-01-02', open: 10, close: 10.5, high: 11, low: 9.8, volume: 12345 },
    ];
    fs.writeFileSync(
      cacheFileFor(code, start, end),
      JSON.stringify({ data: cached, timestamp: Date.now() }),
      'utf-8',
    );

    // spy 必须给 mock 实现：若缓存命中逻辑出 bug（如 timestamp 解析异常判失效），
    // call-through 会真发网络请求
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({}) } as Response);
    const result = await fetchOHLCVData(code, start, end);

    expect(result).toEqual(cached);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('超过 12 小时的缓存视为失效，走网络路径', async () => {
    fs.writeFileSync(
      cacheFileFor(code, start, end),
      JSON.stringify({ data: [{ date: 'x' }], timestamp: Date.now() - 13 * 60 * 60 * 1000 }),
      'utf-8',
    );

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      json: async () => ({ data: { klines: ['2024-01-02,10,10.5,11,9.8,12345'] } }),
    } as Response);

    const result = await fetchOHLCVData(code, start, end);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result[0].close).toBe(10.5);
    fetchSpy.mockRestore();
  });
});

describe('fetchOHLCVData — 网络解析与降级', () => {
  const code = '999002';
  const start = '2024-03-01';
  const end = '2024-03-29';

  afterEach(() => {
    fs.rmSync(cacheFileFor(code, start, end), { force: true });
    vi.restoreAllMocks();
  });

  it('解析东财 klines 文本行（date,open,close,high,low,volume）并写入缓存', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      json: async () => ({
        data: {
          klines: [
            '2024-03-01,10.00,10.50,11.00,9.80,123456',
            '2024-03-04,10.50,10.20,10.80,10.10,234567',
          ],
        },
      }),
    } as Response);

    const result = await fetchOHLCVData(code, start, end);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      date: '2024-03-01',
      open: 10,
      close: 10.5,
      high: 11,
      low: 9.8,
      volume: 123456,
    });
    // 真实数据不带模拟标记
    expect(result[0].isSimulated).toBeUndefined();
    // 成功路径会写缓存
    expect(fs.existsSync(cacheFileFor(code, start, end))).toBe(true);
  });

  it('网络失败降级为确定性模拟数据（isSimulated=true，跳过周末）', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));

    const result = await fetchOHLCVData(code, start, end);
    expect(result.length).toBeGreaterThan(0);
    for (const d of result) {
      expect(d.isSimulated).toBe(true);
      expect(d.high).toBeGreaterThanOrEqual(d.low);
      // 不含周末
      const day = new Date(d.date).getDay();
      expect(day).not.toBe(0);
      expect(day).not.toBe(6);
    }
  });

  it('模拟数据对同一代码/区间是确定性的（两次调用结果一致）', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    const first = await fetchOHLCVData(code, start, end);
    const second = await fetchOHLCVData(code, start, end);
    expect(second).toEqual(first);
  });

  it('响应缺少 klines 字段时同样降级为模拟数据', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      json: async () => ({ data: {} }),
    } as Response);
    const result = await fetchOHLCVData(code, start, end);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].isSimulated).toBe(true);
  });
});

describe('getBenchmarkCurve — 买入持有基准', () => {
  it('空数据返回空数组', () => {
    expect(getBenchmarkCurve([])).toEqual([]);
  });

  it('以首日收盘归一化为 100，保留两位小数', () => {
    const data: OHLCVData[] = [
      { date: '2024-01-02', open: 10, close: 10, high: 10, low: 10, volume: 1 },
      { date: '2024-01-03', open: 10, close: 11, high: 11, low: 10, volume: 1 },
      { date: '2024-01-04', open: 11, close: 9.5, high: 11, low: 9, volume: 1 },
    ];
    const curve = getBenchmarkCurve(data);
    expect(curve.map((p) => p.value)).toEqual([100, 110, 95]);
    expect(curve[0].date).toBe('2024-01-02');
  });
});

describe('marketOf / resolveSecid — 边界情况', () => {
  it('带空白的代码先 trim', () => {
    expect(marketOf(' 600519 ')).toBe('A');
    expect(resolveSecid(' 600519 ')).toBe('1.600519');
  });

  it('无法识别的代码回退为 A 股处理', () => {
    expect(marketOf('12')).toBe('A');
    expect(marketOf('1234567')).toBe('A');
    expect(resolveSecid('1234567')).toBe('0.1234567');
  });
});
