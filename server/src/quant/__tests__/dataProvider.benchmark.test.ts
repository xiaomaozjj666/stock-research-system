/**
 * fetchBenchmarkReturns 单元测试：验证「指数日收益按股票 bars 日期对齐」与降级路径。
 * 经由 DATA_CACHE_DIR 重定向到进程专属临时目录，避免写真实 quant/cache。
 */
import { describe, it, expect, afterEach, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fetchBenchmarkReturns,
  benchmarkSecidForMarket,
  BENCHMARK_SECID_BY_MARKET,
  type Market,
} from '../dataProvider.js';

let CACHE_DIR = '';
const origCacheDir = process.env.DATA_CACHE_DIR;
beforeAll(() => {
  CACHE_DIR = mkdtempSync(join(tmpdir(), 'srs-bench-'));
  process.env.DATA_CACHE_DIR = CACHE_DIR;
});
afterAll(() => {
  if (origCacheDir === undefined) delete process.env.DATA_CACHE_DIR;
  else process.env.DATA_CACHE_DIR = origCacheDir;
  rmSync(CACHE_DIR, { recursive: true, force: true });
});
afterEach(() => vi.restoreAllMocks());

function mockIndexFetch(dates: string[], closes: number[]) {
  const klines = dates.map(
    (d, i) => `${d},${closes[i]},${closes[i]},${closes[i]},${closes[i]},1000000`,
  );
  return vi.spyOn(global, 'fetch').mockResolvedValue({
    json: async () => ({ data: { klines } }),
    ok: true,
  } as unknown as Response);
}

describe('fetchBenchmarkReturns — 对齐与降级', () => {
  it('按股票 bars 日期对齐，首日为 NaN（无前一日），其余为指数日收益', async () => {
    const barDates = ['2024-01-02', '2024-01-03', '2024-01-04', '2024-01-05'];
    const idxCloses = [100, 101, 99, 102];
    mockIndexFetch(barDates, idxCloses);
    const r = await fetchBenchmarkReturns(barDates, '2024-01-01', '2024-01-31');
    expect(r).not.toBeNull();
    expect(Number.isNaN(r![0])).toBe(true);
    expect(r![1]).toBeCloseTo(101 / 100 - 1, 6);
    expect(r![2]).toBeCloseTo(99 / 101 - 1, 6);
    expect(r![3]).toBeCloseTo(102 / 99 - 1, 6);
  });

  it('指数与股票交易历严重错配（对齐率 < 50%）→ 返回 null（避免污染 Beta）', async () => {
    const barDates = ['2024-03-01', '2024-03-02', '2024-03-03', '2024-03-04'];
    mockIndexFetch(['2024-02-01', '2024-02-02', '2024-02-03'], [100, 101, 102]);
    const r = await fetchBenchmarkReturns(barDates, '2024-01-01', '2024-03-31');
    expect(r).toBeNull();
  });

  it('指数不足 2 根 → 返回 null', async () => {
    mockIndexFetch(['2024-04-02'], [100]);
    const r = await fetchBenchmarkReturns(['2024-04-02', '2024-04-03'], '2024-04-01', '2024-04-30');
    expect(r).toBeNull();
  });

  it('指数拉取抛错 → 返回 null（调用方优雅降级）', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('network'));
    const r = await fetchBenchmarkReturns(['2024-05-02', '2024-05-03'], '2024-05-01', '2024-05-31');
    expect(r).toBeNull();
  });

  it('非 A 股（美股）按 SPX secid 拉取并同样按股票日期对齐', async () => {
    const barDates = ['2024-06-02', '2024-06-03', '2024-06-04', '2024-06-05'];
    const idxCloses = [5000, 5050, 4980, 5100];
    mockIndexFetch(barDates, idxCloses);
    const r = await fetchBenchmarkReturns(barDates, '2024-06-01', '2024-06-30', '100.SPX');
    expect(r).not.toBeNull();
    expect(Number.isNaN(r![0])).toBe(true);
    expect(r![1]).toBeCloseTo(5050 / 5000 - 1, 6);
    expect(r![2]).toBeCloseTo(4980 / 5050 - 1, 6);
    expect(r![3]).toBeCloseTo(5100 / 4980 - 1, 6);
  });
});

describe('benchmarkSecidForMarket — 按市场选基准', () => {
  it('A/美股/港股分别映射到沪深300/标普500/恒生', () => {
    expect(benchmarkSecidForMarket('A')).toBe('1.000300');
    expect(benchmarkSecidForMarket('US')).toBe('100.SPX');
    expect(benchmarkSecidForMarket('HK')).toBe('100.HSI');
  });

  it('覆盖全部 Market 取值，无遗漏', () => {
    const markets: Market[] = ['A', 'HK', 'US'];
    for (const m of markets) {
      expect(benchmarkSecidForMarket(m)).toBe(BENCHMARK_SECID_BY_MARKET[m]);
    }
  });
});

describe('benchmarkSecidForMarket — 环境变量覆盖（可配置化）', () => {
  const KEYS = ['QUANT_BENCHMARK_SECID_A', 'QUANT_BENCHMARK_SECID_US', 'QUANT_BENCHMARK_SECID_HK'];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('未设置 env → 使用内置默认（沪深300/标普500/恒生）', () => {
    expect(benchmarkSecidForMarket('A')).toBe('1.000300');
    expect(benchmarkSecidForMarket('US')).toBe('100.SPX');
    expect(benchmarkSecidForMarket('HK')).toBe('100.HSI');
  });

  it('env 覆盖生效：A 股改中证500、美股改纳指100', () => {
    process.env.QUANT_BENCHMARK_SECID_A = '1.000905';
    process.env.QUANT_BENCHMARK_SECID_US = '100.NDX';
    expect(benchmarkSecidForMarket('A')).toBe('1.000905');
    expect(benchmarkSecidForMarket('US')).toBe('100.NDX');
    // 未覆盖的市场仍走默认
    expect(benchmarkSecidForMarket('HK')).toBe('100.HSI');
  });

  it('覆盖值为空/纯空白 → 回落内置默认', () => {
    process.env.QUANT_BENCHMARK_SECID_A = '';
    process.env.QUANT_BENCHMARK_SECID_HK = '   ';
    expect(benchmarkSecidForMarket('A')).toBe('1.000300');
    expect(benchmarkSecidForMarket('HK')).toBe('100.HSI');
  });

  it('覆盖值带首尾空白 → trim 后生效', () => {
    process.env.QUANT_BENCHMARK_SECID_US = '  100.NDX  ';
    expect(benchmarkSecidForMarket('US')).toBe('100.NDX');
  });

  it('每次调用时读取（配置可热改动），非模块加载期固化', () => {
    expect(benchmarkSecidForMarket('US')).toBe('100.SPX');
    process.env.QUANT_BENCHMARK_SECID_US = '100.DJIA';
    expect(benchmarkSecidForMarket('US')).toBe('100.DJIA');
  });
});
