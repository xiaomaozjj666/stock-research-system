/**
 * computeCompositeAlphaForStrategy 单元测试：mock fetch 返回合法 K 线 → 结构正确；
 * fetch 抛错 → 优雅降级（基准不可用但组合仍算出）；空 K 线 → 抛「无法获取」。
 * 经由 DATA_CACHE_DIR 重定向到临时目录，避免写真实 quant/cache。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeCompositeAlphaForStrategy } from '../compositeService.js';

let CACHE_DIR = '';
const origCacheDir = process.env.DATA_CACHE_DIR;
// 每个测试独立缓存目录：避免测试间 K 线缓存串扰（mock 解析结果被后续测试命中）
beforeEach(() => {
  CACHE_DIR = mkdtempSync(join(tmpdir(), 'srs-composite-'));
  process.env.DATA_CACHE_DIR = CACHE_DIR;
});
afterEach(() => {
  vi.restoreAllMocks();
  if (origCacheDir === undefined) delete process.env.DATA_CACHE_DIR;
  else process.env.DATA_CACHE_DIR = origCacheDir;
  rmSync(CACHE_DIR, { recursive: true, force: true });
});

/** 生成 n 根 K 线（date,open=close=high=low,volume），确定性波动 */
function genKlines(n: number, start = '2024-01-01'): string[] {
  const out: string[] = [];
  const d = new Date(start);
  let close = 100;
  for (let i = 0; i < n; i++) {
    close *= 1 + 0.004 * Math.sin(i * 0.3) + 0.001;
    const date = new Date(d.getTime() + i * 86_400_000).toISOString().slice(0, 10);
    out.push(`${date},${close},${close},${close},${close},1000000`);
  }
  return out;
}

describe('computeCompositeAlphaForStrategy — 结构与降级', () => {
  it('合法 K 线 → 返回完整结构（市场/基准/组合 alpha/逐因子预测力）', async () => {
    const klines = genKlines(400);
    vi.spyOn(global, 'fetch').mockResolvedValue({
      json: async () => ({ data: { klines } }),
      ok: true,
    } as unknown as Response);

    const r = await computeCompositeAlphaForStrategy(
      '600519',
      '2024-01-01',
      '2025-03-01',
      [21, 63],
    );
    expect(r.market).toBe('A');
    expect(r.benchmarkSecid).toBe('1.000300');
    expect(r.bars).toBe(400);
    expect(r.horizons).toEqual([21, 63]);
    expect(r.compositeAlpha.horizons).toHaveLength(2);
    expect(r.factorPredictability).toHaveLength(11);
    // 指数与股票同序列（mock 忽略 secid）→ 基准对齐率 100%，可用
    expect(r.benchmarkAvailable).toBe(true);
    expect(['up', 'down', 'neutral']).toContain(r.compositeAlpha.overallDirection);
    expect(typeof r.compositeAlpha.hasSignal).toBe('boolean');
  });

  it('美股代码 → market=US、基准=100.SPX', async () => {
    const klines = genKlines(400);
    vi.spyOn(global, 'fetch').mockResolvedValue({
      json: async () => ({ data: { klines } }),
      ok: true,
    } as unknown as Response);

    const r = await computeCompositeAlphaForStrategy('AAPL', '2024-01-01', '2025-03-01');
    expect(r.market).toBe('US');
    expect(r.benchmarkSecid).toBe('100.SPX');
    expect(r.factorPredictability).toHaveLength(11);
  });

  it('基准拉取抛错 → 优雅降级（benchmarkAvailable=false，组合仍算出）', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('network'));
    const r = await computeCompositeAlphaForStrategy('600519', '2024-01-01', '2025-03-01');
    expect(r.benchmarkAvailable).toBe(false);
    expect(r.compositeAlpha.horizons).toHaveLength(2);
    expect(r.factorPredictability).toHaveLength(11);
  });

  it('空 K 线 → 抛「无法获取 K 线数据」', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      json: async () => ({ data: { klines: [] } }),
      ok: true,
    } as unknown as Response);
    await expect(
      computeCompositeAlphaForStrategy('600519', '2024-01-01', '2025-03-01'),
    ).rejects.toThrow(/无法获取/);
  });
});
