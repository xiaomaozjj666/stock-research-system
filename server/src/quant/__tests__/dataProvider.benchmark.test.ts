/**
 * fetchBenchmarkReturns 单元测试：验证「指数日收益按股票 bars 日期对齐」与降级路径。
 * 经由 DATA_CACHE_DIR 重定向到进程专属临时目录，避免写真实 quant/cache。
 */
import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchBenchmarkReturns } from '../dataProvider.js';

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
});
